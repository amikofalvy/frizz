// A Claude Code session that never runs a turn, kept by the server for one project so the prompt box's
// MCP menu has something to ask when no thread session can answer: the new-thread box (no thread yet),
// and a thread whose broker daemon is not running. It is also where every Claude MCP sign-in happens.
//
// WHY A SESSION AND NOT A FILE READ. Whether a remote server needs a sign-in is Claude Code's own verdict:
// it depends on the token store (the macOS keychain, or `.credentials.json`), on a token's expiry and
// refresh, and on whether the server answers at all. The SDK's `mcpServerStatus()` is that verdict, and
// it is asked of a CLI that has connected to the servers — so the probe IS a CLI, started with the same
// server list a new worker in this project gets (project-mcp-servers.ts) and no prompt, ever. No model
// turn runs and nothing is written to disk (`persistSession: false`), so it costs a process and no tokens.
//
// WHY SIGN-INS RUN HERE. `mcpAuthenticate` registers the pending OAuth flow inside the CLI that started
// it: that CLI listens on `localhost` for the browser's return trip, swaps the code for a token, saves it
// to the store every Claude session on the machine shares, and reconnects. A thread's daemon could host
// it too, but then a sign-in started from the new-thread box would have nowhere to run. Running all of
// them here gives one path; the caller then asks the live threads to reconnect (the bridge's fan-out).
// The token key is the server's name and `{type, url, headers}`, which the probe takes from the same
// config the workers do, so a token saved here is the one a worker looks up.
//
// ONLY REMOTE SERVERS. A stdio server cannot need a sign-in, and starting one is exactly the cost the lazy
// host exists to avoid (lazy-mcp-host.ts) — a browser server would open a browser to fill a menu. Stdio
// servers are listed from the config instead, as connected (what a live thread's lazy host reports for
// them too), with the tool count the lazy host's cache remembers.
//
// LIFETIME. Started on first use, reused while the project's remote servers stay the same (a changed
// list restarts it), and closed after IDLE_MS without a call — unless a sign-in is waiting on it, which
// holds it open until the sign-in settles or expires.
import { randomUUID } from "node:crypto"
import { createClaudeQueryFactory, type ClaudeQueryFactory, type ClaudeQueryHandle } from "./claude-agent-sdk.ts"
import type { ClaudeMcpAuthStart, ClaudeMcpServerReading } from "./claude-agent-sdk-protocol.ts"
import { lazyMcpCachedToolCount } from "./lazy-mcp-host.ts"
import { projectMcpServers, type StdioMcpServer, type WorkerMcpServers } from "./project-mcp-servers.ts"

const IDLE_MS = 10 * 60 * 1000
// A fresh CLI reports every remote server `pending` until its handshake lands — about a second for a
// reachable server. A read waits this long for them to settle before answering with whatever it has.
const SETTLE_MS = 8_000
const SETTLE_POLL_MS = 250

export interface ClaudeMcpProbe {
  /** Every server a new Claude thread in this project mounts, with its state. */
  status(): Promise<ClaudeMcpServerReading[]>
  /** Start `name`'s sign-in in the probe session. Holds the session open until `release(name)`. */
  authenticate(name: string): Promise<ClaudeMcpAuthStart>
  /** One server's state, read fresh — for watching a sign-in land. */
  serverStatus(name: string): Promise<ClaudeMcpServerReading | undefined>
  /** Drop the hold a sign-in took. */
  release(name: string): void
  close(): Promise<void>
}

export interface ClaudeMcpProbeOptions {
  projectDir: string
  executablePath: string
  /** The worker environment: what `${VAR}` in `.mcp.json` resolves against, and what the CLI runs with. */
  env: Record<string, string>
  /** The lazy host's cache, for stdio servers' tool counts. */
  lazyCacheDir?: string
  /** Tests inject a fake. */
  factory?: ClaudeQueryFactory
  idleMs?: number
}

const isRemote = (server: WorkerMcpServers[string]): boolean => server.type === "http" || server.type === "sse"

export function createClaudeMcpProbe(options: ClaudeMcpProbeOptions): ClaudeMcpProbe {
  const factory = options.factory ?? createClaudeQueryFactory({ enabled: true, executablePath: options.executablePath })
  const idleMs = options.idleMs ?? IDLE_MS
  let session: { handle: ClaudeQueryHandle; fingerprint: string } | undefined
  let idleTimer: NodeJS.Timeout | undefined
  const holds = new Set<string>()

  const config = (): WorkerMcpServers => projectMcpServers(options.projectDir, { env: options.env })

  const closeSession = async (): Promise<void> => {
    const current = session
    session = undefined
    await current?.handle.close().catch(() => {})
  }

  const touch = (): void => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { if (holds.size === 0) void closeSession() }, idleMs)
    idleTimer.unref?.()
  }

  // The session for the CURRENT remote server list, started (or restarted) as needed. `undefined` when the
  // project has no remote server, which needs no session at all.
  const ensure = async (remote: WorkerMcpServers): Promise<ClaudeQueryHandle | undefined> => {
    touch()
    if (Object.keys(remote).length === 0) { await closeSession(); return undefined }
    const fingerprint = JSON.stringify(remote)
    if (session?.fingerprint === fingerprint) return session.handle
    await closeSession()
    const handle = factory.start({
      cwd: options.projectDir,
      session: { kind: "new", sessionId: randomUUID() },
      permissionMode: "default",
      env: options.env,
      persistSession: false,
      mcpServers: remote,
      strictMcpConfig: true,
      // Hermetic: no hooks, plugins or settings — nothing but the servers. The token store is not a
      // setting, so the verdict is the one a worker gets.
      settingSources: [],
    })
    session = { handle, fingerprint }
    // Drain the event stream: the handle buffers what it is not asked for, and a session that never runs
    // a turn still emits the odd system frame. Its end (the CLI exiting) retires the session.
    void (async () => {
      try { for await (const _event of handle) { /* nothing to read */ } } catch {}
      if (session?.handle === handle) session = undefined
    })()
    return handle
  }

  // Read the session's servers, waiting for `pending` ones to settle.
  const read = async (handle: ClaudeQueryHandle): Promise<ClaudeMcpServerReading[]> => {
    const deadline = Date.now() + SETTLE_MS
    for (;;) {
      const rows = await handle.mcpServerStatus()
      if (!rows.some((row) => row.status === "pending") || Date.now() >= deadline) return rows
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
    }
  }

  const stdioRow = (name: string, server: StdioMcpServer): ClaudeMcpServerReading => {
    const tools = options.lazyCacheDir ? lazyMcpCachedToolCount(server, options.projectDir, options.lazyCacheDir) : undefined
    return { name, status: "connected", remote: false, ...(tools !== undefined ? { tools } : {}) }
  }

  return {
    async status() {
      const all = config()
      const remote = Object.fromEntries(Object.entries(all).filter(([, server]) => isRemote(server)))
      const handle = await ensure(remote)
      const live = handle ? await read(handle) : []
      const byName = new Map(live.map((row) => [row.name, row]))
      return Object.entries(all).map(([name, server]) => isRemote(server)
        ? (byName.get(name) ?? { name, status: "pending" as const, remote: true })
        : stdioRow(name, server as StdioMcpServer))
    },

    async authenticate(name) {
      const remote = Object.fromEntries(Object.entries(config()).filter(([, server]) => isRemote(server)))
      if (!(name in remote)) throw new Error(`${name} is not a remote MCP server of this project, so it has no sign-in`)
      const handle = await ensure(remote)
      if (!handle) throw new Error("No remote MCP server to sign in to")
      // Let the server's first handshake land first: authenticating a server the CLI is still connecting
      // to races its own discovery of the same OAuth metadata.
      await read(handle)
      holds.add(name)
      try {
        return await handle.mcpAuthenticate(name)
      } catch (error) {
        holds.delete(name)
        throw error
      }
    },

    async serverStatus(name) {
      const current = session?.handle
      if (!current) return undefined
      touch()
      return (await current.mcpServerStatus()).find((row) => row.name === name)
    },

    release(name) {
      holds.delete(name)
      touch()
    },

    async close() {
      clearTimeout(idleTimer)
      holds.clear()
      await closeSession()
    },
  }
}
