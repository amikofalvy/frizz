import { join } from "node:path"
import { frizzRoots } from "../frizz-paths.ts"
import { homedir, platform } from "node:os"
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ProviderQuota, QuotaWindow } from "@frizz/shared"

const execFileAsync = promisify(execFile)

// Subscription quota is read ONLY from the OAuth usage endpoint — the same call Claude Code's own
// /usage command makes — authorized by the credential already on this machine (the on-disk
// ~/.claude/.credentials.json, or the macOS login Keychain). That is one ~200ms HTTPS GET, immune to
// local CPU load. There is no `claude -p /usage` fallback any more: it booted a whole Claude Code
// process, and when the endpoint kept failing every project's 30s heartbeat spawned one — measured
// 2026-10-08 at ~8 spawns/min and ~9% of a core, for a reading that still came back unavailable. A
// failed refresh now just serves the last good reading until the endpoint answers again.
//
//   GET https://api.anthropic.com/api/oauth/usage
//     Authorization: Bearer <oauth access token>
//     anthropic-beta: oauth-2025-04-20
//     User-Agent: claude-code/<version>      ← REQUIRED; without it the endpoint 429s aggressively
//   → { five_hour:{utilization 0..100, reset_at ISO}, seven_day:{…}, seven_day_opus, seven_day_sonnet }
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const OAUTH_BETA = "oauth-2025-04-20"
const USER_AGENT = "claude-code/2.0.0" // gates by product, not exact version
const ENDPOINT_TIMEOUT_MS = 5000
// A healthy reading is trusted for two minutes. The endpoint is one cheap ~200ms GET, and a proactive
// server-side heartbeat (refreshClaudeQuotaInBackground, wired in context.ts) already keeps this cache
// warm, so a lazy read reflects a value about as recent as the endpoint's rate limit allows (see
// RATE_LIMIT_DEFAULT_BACKOFF_MS — in practice ~5 minutes, not these 2). FAIL keeps its tight 10s retry.
const OK_TTL_MS = 2 * 60_000
const FAIL_TTL_MS = 10_000
const STALE_MAX_AGE_MS = 24 * 60 * 60_000
// The lock must outlive the slowest refresh (a keychain read plus the endpoint's timeout), and
// followers must be willing to wait through that bound. Otherwise a merely slow first process would make
// every other Frizz window give up early.
const LOCK_STALE_MS = 15_000
const LOCK_WAIT_MS = 10_000
const LOCK_POLL_MS = 50
// THE ENDPOINT RATE-LIMITS PER ACCESS TOKEN, HARD: measured 2026-09-19, one success bought a 429 with
// `retry-after` counting down a fixed ~5-minute window, and every Claude Code session on the machine
// shares that token's budget (upstream: anthropics/claude-code#31637). A caller that ignores the header
// spends most of its requests on refusals — a 2-minute heartbeat landed one success in three, and every
// popover recheck inside the window failed, which is why "Could not refresh" was the popover's usual
// reading. So the refusal's deadline is PERSISTED beside the reading (`retryAt`) and nothing — heartbeat,
// stale-read kick, forced recheck — calls the endpoint before it. Upstream also reports 429s carrying
// `retry-after: 0` or no header at all; those get this default. The cap bounds an absurd header.
const RATE_LIMIT_DEFAULT_BACKOFF_MS = 5 * 60_000
const RATE_LIMIT_MAX_BACKOFF_MS = 60 * 60_000

function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR
  return override && override.trim() ? override : join(homedir(), ".claude")
}

// Pull the OAuth access token out of a Claude credentials blob. The shape has drifted across
// versions, so probe the known nests defensively; return undefined when absent.
export function tokenFromCredentialsJson(raw: string): string | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!doc || typeof doc !== "object") return undefined
  const root = doc as Record<string, unknown>
  const oauth = root.claudeAiOauth && typeof root.claudeAiOauth === "object" ? (root.claudeAiOauth as Record<string, unknown>) : root
  const token = oauth.accessToken ?? oauth.access_token
  return typeof token === "string" && token ? token : undefined
}

// Keychain path for a default macOS install (no .credentials.json on disk; `security -w` prints the
// same blob shape as the file). Defensive: darwin-only, short timeout, swallow any error → undefined.
// ASYNC on purpose: a Keychain ACL prompt can block until the timeout, and a synchronous exec would
// freeze the whole server event loop for that window.
async function readKeychainToken(): Promise<string | undefined> {
  if (platform() !== "darwin") return undefined
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      encoding: "utf8",
      timeout: 4000,
    })
    return tokenFromCredentialsJson(String(stdout).trim())
  } catch {
    return undefined
  }
}

// The OAuth access token, tried in the order Claude Code itself resolves it: the on-disk
// .credentials.json first (Linux, and macOS installs that opted out of the Keychain), then the macOS
// login Keychain. Returns undefined only when NEITHER source yields a token.
async function readAccessToken(configDir: string): Promise<string | undefined> {
  try {
    const fromFile = tokenFromCredentialsJson(await readFile(join(configDir, ".credentials.json"), "utf8"))
    if (fromFile) return fromFile
  } catch {
    // Missing/unreadable file is expected on a Keychain-backed macOS install — fall through.
  }
  return readKeychainToken()
}

function isoToUnix(value: unknown): number | undefined {
  const ms = typeof value === "string" ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? Math.round(ms / 1000) : undefined
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

// Map one legacy usage window from the endpoint (utilization 0..100, reset_at/resets_at ISO).
function toWindow(raw: unknown, key: string, label: string): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const w = raw as Record<string, unknown>
  const util = typeof w.utilization === "number" && Number.isFinite(w.utilization) ? w.utilization : undefined
  if (util === undefined) return undefined
  const resetsAt = isoToUnix(w.resets_at ?? w.reset_at)
  return { key, label, usedPercent: util, ...(resetsAt === undefined ? {} : { resetsAt }) }
}

// Map one modern `limits[]` entry: { kind, group, percent, resets_at, scope: { model: { display_name } } }.
// A scoped weekly ("weekly_scoped" with a model name — e.g. the Fable weekly cap on a Fable plan) keeps
// its model identity so the chip's tightest-window pick can name the cap that actually binds.
function windowFromLimit(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const l = raw as Record<string, unknown>
  const percent = typeof l.percent === "number" && Number.isFinite(l.percent) ? l.percent : undefined
  if (percent === undefined) return undefined
  const group = typeof l.group === "string" ? l.group : typeof l.kind === "string" ? l.kind : ""
  const scope = l.scope && typeof l.scope === "object" ? (l.scope as Record<string, unknown>) : undefined
  const model = scope?.model && typeof scope.model === "object" ? (scope.model as Record<string, unknown>) : undefined
  const scopeName = typeof model?.display_name === "string" && model.display_name ? model.display_name : undefined
  let key: string
  let label: string
  if (group === "session") {
    key = "5h"
    label = "5h"
  } else if (group === "weekly") {
    key = scopeName ? `weekly-${slugify(scopeName)}` : "weekly"
    label = scopeName ? `${scopeName} wk` : "Weekly"
  } else if (group) {
    // An unfamiliar future cap must not be invisible — it may be the one that binds.
    key = slugify(group)
    label = scopeName ? `${scopeName} ${group}` : group
  } else {
    return undefined
  }
  const resetsAt = isoToUnix(l.resets_at ?? l.reset_at)
  return { key, label, usedPercent: percent, ...(resetsAt === undefined ? {} : { resetsAt }) }
}

// Parse the endpoint's JSON body → a ProviderQuota. Total: never throws. Exported for a fixture test.
// The modern body carries the authoritative windows in `limits[]` (session + weekly entries, scoped
// weeklies naming their model); older bodies used top-level five_hour / seven_day / seven_day_<model>
// objects. Read `limits[]` first and fill any window the legacy keys still uniquely describe — the
// model-scoped weekly caps matter because they are frequently the BINDING limit, and omitting one
// would let the chip show a rosy general weekly % while the user is actually near that wall.
export function parseClaudeUsage(body: unknown, planType?: string): ProviderQuota {
  if (!body || typeof body !== "object") return { status: "unavailable", windows: [], detail: "Malformed usage response" }
  const b = body as Record<string, unknown>
  const windows: QuotaWindow[] = []
  const seen = new Set<string>()
  const add = (w: QuotaWindow | undefined) => {
    if (w && !seen.has(w.key)) {
      seen.add(w.key)
      windows.push(w)
    }
  }
  if (Array.isArray(b.limits)) for (const entry of b.limits) add(windowFromLimit(entry))
  add(toWindow(b.five_hour, "5h", "5h"))
  add(toWindow(b.seven_day, "weekly", "Weekly"))
  add(toWindow(b.seven_day_opus, "weekly-opus", "Opus wk"))
  add(toWindow(b.seven_day_sonnet, "weekly-sonnet", "Sonnet wk"))
  if (windows.length === 0) return { status: "unavailable", windows: [], detail: "No usage windows reported" }
  return { status: "ok", planType, windows }
}

/** The endpoint refused with 429/529. `retryAt` (ms) is when it said another request may succeed. */
class UsageRateLimited extends Error {
  constructor(status: number, readonly retryAt: number) {
    super(`Usage endpoint ${status}`)
  }
}

function retryAtFrom(res: Response, now: number): number {
  const seconds = Number(res.headers.get("retry-after"))
  const backoff = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : RATE_LIMIT_DEFAULT_BACKOFF_MS
  return now + Math.min(backoff, RATE_LIMIT_MAX_BACKOFF_MS)
}

export interface ClaudeQuotaDeps {
  now?: () => number
  cacheDir?: string
  fetchImpl?: typeof fetch
  readToken?: (configDir: string) => Promise<string | undefined>
}

interface SharedQuota {
  at: number
  quota: ProviderQuota
  /** Set by a 429: no caller touches the endpoint before this instant (ms). A success clears it. */
  retryAt?: number
}

function cachePaths(cacheDir: string, configDir: string) {
  const profile = createHash("sha256").update(configDir).digest("hex").slice(0, 12)
  return {
    data: join(cacheDir, `claude-${profile}.json`),
    lock: join(cacheDir, `claude-${profile}.lock`),
  }
}

async function readShared(path: string): Promise<SharedQuota | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as SharedQuota
    if (!Number.isFinite(parsed.at) || !parsed.quota || !Array.isArray(parsed.quota.windows)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

async function writeShared(path: string, value: SharedQuota): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await mkdir(path)
      return () => rm(path, { recursive: true, force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      try {
        if (Date.now() - (await stat(path)).mtimeMs > LOCK_STALE_MS) {
          await rm(path, { recursive: true, force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() >= deadline) throw new Error("Claude quota refresh lock timed out")
      await delay(LOCK_POLL_MS)
    }
  }
}

// One live refresh against the endpoint. Returns ONLY a healthy quota; every failure shape throws so the
// callers' stale-serving catch handles them uniformly.
async function refreshQuota(deps: ClaudeQuotaDeps, now: number): Promise<ProviderQuota> {
  const doFetch = deps.fetchImpl ?? fetch
  const readToken = deps.readToken ?? readAccessToken
  let token: string | undefined
  try {
    token = await readToken(claudeConfigDir())
  } catch {
    token = undefined
  }
  if (!token) throw new Error("No Claude Code credential")
  const res = await doFetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA,
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
  })
  if (res.status === 429 || res.status === 529) throw new UsageRateLimited(res.status, retryAtFrom(res, now))
  // 401/403 is a token Claude Code has not refreshed yet; its next session rotates it on disk/Keychain
  // and the next tick reads the new one.
  if (!res.ok) throw new Error(`Usage endpoint ${res.status}`)
  const body = (await res.json()) as Record<string, unknown>
  const planType = typeof body.plan_type === "string" ? body.plan_type : undefined
  const quota = parseClaudeUsage(body, planType)
  if (quota.status !== "ok") throw new Error(quota.detail)
  return quota
}

// One non-blocking lock attempt for a BACKGROUND refresh: if another process holds the lock, someone
// is already refreshing and this process's next poll will read their result — give up instantly
// instead of parking a waiter.
async function tryAcquireLock(path: string): Promise<(() => Promise<void>) | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(path)
      return () => rm(path, { recursive: true, force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return undefined
      try {
        if (Date.now() - (await stat(path)).mtimeMs <= LOCK_STALE_MS) return undefined
        await rm(path, { recursive: true, force: true })
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

const UNAVAILABLE = { status: "unavailable", windows: [], detail: "Claude Code usage unavailable" } satisfies ProviderQuota

function rateLimited(shared: SharedQuota | undefined, now: number): shared is SharedQuota & { retryAt: number } {
  return shared?.retryAt !== undefined && now < shared.retryAt
}

// What a caller gets INSTEAD of a request while the endpoint's refusal stands. This is not a failure —
// the reading is as fresh as the provider allows — so it says when the next one is due rather than
// "Could not refresh". House duration grammar (`3m`), minutes floored at 1 so it never reads `0m`.
function serveRateLimited(shared: SharedQuota & { retryAt: number }, now: number): ProviderQuota {
  if (shared.quota.status !== "ok" || now - shared.at >= STALE_MAX_AGE_MS) return UNAVAILABLE
  const minutes = (ms: number, round: (n: number) => number) => Math.max(1, round(ms / 60_000))
  return {
    ...shared.quota,
    detail: `Next refresh in ${minutes(shared.retryAt - now, Math.ceil)}m · last updated ${minutes(now - shared.at, Math.round)}m ago`,
  }
}

// In-process guard so overlapping polls from one server start at most one background refresh.
const backgroundRefreshes = new Map<string, Promise<void>>()

function refreshSharedInBackground(paths: { data: string; lock: string }, deps: ClaudeQuotaDeps, now: number): void {
  if (backgroundRefreshes.has(paths.data)) return
  const task = (async () => {
    if (rateLimited(await readShared(paths.data), now)) return
    const release = await tryAcquireLock(paths.lock)
    if (!release) return
    try {
      const quota = await refreshQuota(deps, now)
      await writeShared(paths.data, { at: now, quota })
    } catch (err) {
      if (!(err instanceof UsageRateLimited)) throw err
      // Keep the reading and its age; record only the deadline, so the next tick does not ask again.
      const current = await readShared(paths.data)
      await writeShared(paths.data, { ...(current ?? { at: now, quota: UNAVAILABLE }), retryAt: err.retryAt })
    } finally {
      await release().catch(() => {})
    }
  })().catch(() => {})
    .finally(() => backgroundRefreshes.delete(paths.data))
  backgroundRefreshes.set(paths.data, task)
}

/** Test seam: resolves once any in-flight background refreshes have settled. */
export async function claudeQuotaRefreshSettled(): Promise<void> {
  await Promise.all([...backgroundRefreshes.values()])
}

// Proactively refresh the shared quota cache on a fixed schedule, independent of whether any browser is
// polling. The freshness of the sidebar chip (and the scheduler's weekly-reset check) used to be a
// side effect of someone READING the cache: with a 3-minute stale-while-revalidate TTL and a 60s
// browser poll, the displayed reading could lag 3–4 minutes — long enough to blow past a limit during
// a fast fleet burn without the chip ever warning. A server-side heartbeat ticking this every 30s
// keeps the cache as warm as the endpoint allows: a tick is a no-op while the reading is inside its
// TTL or the endpoint's `retryAt` has not passed.
//
// It uses the SAME non-blocking background path a stale read kicks — one in-flight refresh per process,
// cross-process lock so N Frizz processes make one request per window per account. It NEVER blocks the
// caller and swallows every failure (the last known-good reading rides until the next success).
export async function refreshClaudeQuotaInBackground(deps: ClaudeQuotaDeps = {}): Promise<void> {
  const now = (deps.now ?? Date.now)()
  const configDir = claudeConfigDir()
  const cacheDir = deps.cacheDir ?? join(frizzRoots().cache, "quota-cache")
  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  } catch {
    return // No shared cache dir → nothing to warm; a lazy read still has its own no-cache fallback.
  }
  const paths = cachePaths(cacheDir, configDir)
  // The heartbeat ticks faster than the TTL so a refresh lands soon after the endpoint's `retryAt`
  // rather than up to a whole interval late; a reading still inside its TTL needs nothing.
  const current = await readShared(paths.data)
  if (current?.quota.status === "ok" && now - current.at < OK_TTL_MS) return
  refreshSharedInBackground(paths, deps, now)
}

// The healthy cache is shared under ~/.frizz so three project windows make one endpoint request,
// not three simultaneous requests to the same account. A failed refresh serves the last known-good
// reading (clearly labeled in the popover) for at most one day instead of erasing useful data.
//
// Ordinary (non-force) reads are STALE-WHILE-REVALIDATE: any known-good reading newer than a day is
// returned immediately and the refresh happens in the background. The poll must never block on the
// refresh + cross-process lock — responses that slow straddle dev-server restarts and
// leave the browser's fetch hung, which is exactly how the chip froze into an em dash. Only `force`
// (the popover's explicit recheck) waits for a live refresh.
export async function readClaudeQuota(
  deps: ClaudeQuotaDeps = {},
  options: { force?: boolean } = {},
): Promise<ProviderQuota> {
  const now = (deps.now ?? Date.now)()
  const configDir = claudeConfigDir()
  const cacheDir = deps.cacheDir ?? join(frizzRoots().cache, "quota-cache")
  const paths = cachePaths(cacheDir, configDir)
  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  } catch {
    try {
      return await refreshQuota(deps, now)
    } catch {
      return { status: "unavailable", windows: [], detail: "Claude usage unavailable" }
    }
  }
  const initial = await readShared(paths.data)
  if (!options.force && initial && now - initial.at < (initial.quota.status === "ok" ? OK_TTL_MS : FAIL_TTL_MS)) {
    return initial.quota
  }
  if (!options.force && initial?.quota.status === "ok" && now - initial.at < STALE_MAX_AGE_MS) {
    refreshSharedInBackground(paths, deps, now)
    const ageMs = now - initial.at
    if (ageMs >= 10 * 60_000 && rateLimited(initial, now)) return serveRateLimited(initial, now)
    // Freshly-expired data is normal churn; only label the reading once it is meaningfully old.
    if (ageMs < 10 * 60_000) return initial.quota
    return { ...initial.quota, detail: `Refreshing · last updated ${Math.round(ageMs / 60_000)}m ago` }
  }

  // A forced recheck inside the refusal window cannot succeed; asking anyway only buys another 429.
  if (rateLimited(initial, now)) return serveRateLimited(initial, now)

  let release: (() => Promise<void>) | undefined
  try {
    release = await acquireLock(paths.lock)
    const afterLock = await readShared(paths.data)
    if (rateLimited(afterLock, now)) return serveRateLimited(afterLock, now)
    // Another Frizz process may have completed the requested refresh while this process waited.
    if (afterLock && afterLock.at !== initial?.at && now - afterLock.at < OK_TTL_MS) return afterLock.quota

    const quota = await refreshQuota(deps, now)
    await writeShared(paths.data, { at: now, quota }).catch(() => {})
    return quota
  } catch (err) {
    const fallback = await readShared(paths.data)
    if (err instanceof UsageRateLimited) {
      const refused = { ...(fallback ?? { at: now, quota: UNAVAILABLE }), retryAt: err.retryAt }
      await writeShared(paths.data, refused).catch(() => {})
      return serveRateLimited(refused, now)
    }
    if (fallback?.quota.status === "ok" && now - fallback.at < STALE_MAX_AGE_MS) {
      return {
        ...fallback.quota,
        detail: `Could not refresh · last updated ${Math.max(1, Math.round((now - fallback.at) / 60_000))}m ago`,
      }
    }
    await writeShared(paths.data, { at: now, quota: UNAVAILABLE }).catch(() => {})
    return UNAVAILABLE
  } finally {
    await release?.().catch(() => {})
  }
}
