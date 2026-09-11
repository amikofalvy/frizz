export interface RestartFrizzResult {
  protocol: 1
  state: "ready" | "restarting" | "failed"
  message?: string
}

export interface FrizzSupervisorStatus {
  protocol: 1
  state: "ready" | "restarting" | "failed"
  message?: string
  artifactDigest?: string
  /** Only frizz-dev's durable supervisor can safely build and promote a replacement artifact. */
  updateRestart?: boolean
  /**
   * Is a newer artifact actually available? Sent only by a launcher that can answer it (the registry
   * launcher, which knows its own version and the registry's latest). ABSENT means "cannot tell —
   * assume yes", which is right for frizz-dev, where an update rebuilds from source and is always
   * meaningful.
   */
  updateAvailable?: boolean
  /**
   * The published package version this Frizz is running. Sent only by the registry launcher — a
   * frizz-dev board runs mutable checkout source with no version a user could act on, so absence
   * means "show no version at all".
   */
  version?: string
  /**
   * The NEWER registry version behind `updateAvailable`, once the launcher has actually observed
   * one. Absent while the registry has not answered (the launcher starts update-optimistic) and on
   * frizz-dev, so the popover only ever names a version it can deliver.
   */
  updateVersion?: string
  /**
   * Is this Frizz a DEVELOPMENT build — launched from a source checkout by `frizz-dev` or `pnpm dev`,
   * rather than the published `frizz` bin? Sent only when true, so absent means "no".
   *
   * The client cannot answer this itself. `import.meta.env.DEV` is a Vite COMPILE-TIME constant, true
   * only under `vite dev` middleware — and frizz-dev's ordinary route builds an immutable artifact and
   * serves the Vite PRODUCTION bundle, where it is statically `false`. Gating a dev-only affordance on
   * it therefore eliminated that affordance from the build the maintainer runs all day. Only the
   * launcher knows, so it says so here.
   */
  dev?: boolean
}

/** Wakes the app-level status monitor immediately after a control action is accepted. */
export const FRIZZ_SUPERVISOR_STATUS_WAKE_EVENT = "frizz:supervisor-status-wake"

// ── What the clicking tab remembers across an update (per tab: sessionStorage) ────────────────────────
// The button arms both when the supervisor ACCEPTS an update-restart; App consumes both when a later
// poll settles it. The destination is the route to reload onto once the successor is ready. The
// version is what "failed" is measured against (finding 11, audit 2026-09-11): a "failed" that still
// names the version we clicked on means the OLD launcher gave up and kept serving; one that names a
// NEWER version means the successor came up and then could not start its board — and the previous
// version is gone, so the copy that says it kept running would be a lie.
export const RELOAD_AFTER_UPDATE_RESTART = "frizz:reload-after-update-restart"
export const UPDATE_RESTART_FROM_VERSION = "frizz:update-restart-from-version"

export type RestartFailureOutcome =
  | { kind: "previous-kept" }
  | { kind: "successor-failed"; version?: string }

/**
 * Which of the two failures a `failed` status is reporting, judged by the version it carries against
 * the one that was running when the operator clicked. Identical (or both absent — frizz-dev names no
 * version, and its durable supervisor rolls back in place) ⇒ the previous version kept running.
 * Different ⇒ the new version answered, so it is the one that failed.
 */
export function restartFailureOutcome(versionAtRequest: string | undefined, status: Pick<FrizzSupervisorStatus, "version">): RestartFailureOutcome {
  if (status.version === versionAtRequest) return { kind: "previous-kept" }
  return { kind: "successor-failed", version: status.version }
}

/** The sentence for the failure panel and the shorter tail the toast appends to "Update & Restart failed". */
export function restartFailureCopy(outcome: RestartFailureOutcome): { summary: string; detail: string } {
  if (outcome.kind === "previous-kept") {
    return {
      summary: "Frizz kept running the previous version",
      detail: "Frizz kept running the previous version, and your threads are unaffected.",
    }
  }
  const name = outcome.version ? `Frizz ${outcome.version}` : "The new version of Frizz"
  return {
    summary: `${name} failed to start`,
    detail: `${name} came up but could not start its board, and the previous version is gone. Restart Frizz from the terminal (npx frizz) and check its log for the reason.`,
  }
}

// ── Which BUILD a tab is talking to (finding 8, audit 2026-09-11) ─────────────────────────────────────
// Only the tab that clicked Update reloads by arming a destination above; every other open tab used to
// ride "restarting" → overlay → "ready" → overlay drops, and keep the OLD web bundle against the NEW
// server. The identity is the artifact digest where the supervisor reports one (frizz-dev's durable
// owner), else the package version (the registry launcher); a supervisor that names neither cannot be
// told apart across a restart, so it never triggers a reload.
export function frizzBuildIdentity(status: FrizzSupervisorStatus | null): string | null {
  return status?.artifactDigest ?? status?.version ?? null
}

/**
 * Reload when a READY answer names a build other than the one this page first saw. Only "ready": a
 * "restarting"/"failed" answer from a successor still serves nothing a reload could load, and the
 * ready answer that follows will carry the same new identity anyway.
 */
export function shouldReloadForNewBuild(seen: string | null, status: FrizzSupervisorStatus | null): boolean {
  if (seen === null || status?.state !== "ready") return false
  const current = frizzBuildIdentity(status)
  return current !== null && current !== seen
}

// ── The restart hold's deadline (finding 1, audit 2026-09-11) ─────────────────────────────────────────
// After a detached handoff the old process exits and every poll of /_frizz/control/status comes back
// null. App used to ignore a null answer entirely, so a successor that never came up left every tab in
// "restarting" behind the hard-blocking overlay, with no message and no way out. The hold now has a
// clock: silence is measured from the first null answer since the supervisor last spoke, and past the
// deadline the overlay stops blocking and says what to do. A poll that gets ANY protocol answer
// (including "restarting" from a durable supervisor still building) resets it — a slow build is not a
// dead board. Three minutes is a deliberate margin over the wait the launcher itself gives a successor
// before it restores the previous version, so the board never gives up before the launcher has.
export const RESTART_HOLD_DEADLINE_MS = 3 * 60_000

export interface RestartHold {
  /** The instant of the first unanswered poll in the current run of silence; null while the supervisor is answering (or nothing is restarting). */
  silentSince: number | null
  /** How long the silence has run as of the latest poll, so the overlay can say `3m` without reading a clock in render. */
  silentForMs: number
  /** Past the deadline: the overlay stops blocking and tells the operator to restart from the terminal. */
  stalled: boolean
}

export const IDLE_RESTART_HOLD: RestartHold = { silentSince: null, silentForMs: 0, stalled: false }

/**
 * One step of the hold, per poll answer. Pure so the deadline is testable as arithmetic rather than
 * through the React effect that drives it: `restarting` is what the board shows after applying this
 * poll, `answered` is whether the poll got a protocol answer at all.
 */
export function nextRestartHold(
  prev: RestartHold,
  poll: { restarting: boolean; answered: boolean; at: number },
  deadlineMs: number = RESTART_HOLD_DEADLINE_MS,
): RestartHold {
  if (!poll.restarting || poll.answered) return IDLE_RESTART_HOLD
  const silentSince = prev.silentSince ?? poll.at
  const silentForMs = Math.max(0, poll.at - silentSince)
  return { silentSince, silentForMs, stalled: silentForMs >= deadlineMs }
}

/** Every supervisor that speaks the control protocol can restart its disposable application child. */
export function canRestart(status: FrizzSupervisorStatus | null): boolean {
  return status !== null
}

/**
 * Should this button offer to UPDATE rather than merely restart?
 *
 * Two conditions, and conflating them was a real shipped bug: `updateRestart` says the verb is WIRED
 * (legacy/static supervisors omit it, so their recovery endpoint is never surfaced as an update), while
 * `updateAvailable` says a newer artifact actually EXISTS. With only the first, a fully up-to-date
 * production Frizz still read "Update Frizz" and a click reinstalled its own version and restarted the
 * app for nothing — measured end-to-end against the published package.
 *
 * `updateAvailable` absent ⇒ treated as available, so frizz-dev (which can always rebuild from source,
 * and has no "already current" notion) is unchanged.
 */
export function canUpdateRestart(status: FrizzSupervisorStatus | null): boolean {
  return status?.updateRestart === true && status.updateAvailable !== false
}

/**
 * Is Frizz itself running as a development build? Deliberately strict: an unreachable supervisor, a
 * legacy one that predates the field, and a published Frizz all read the same — NOT a dev build — so a
 * dev-only verb can never appear for someone who merely installed Frizz.
 */
export function isDevFrizzBuild(status: FrizzSupervisorStatus | null): boolean {
  return status?.dev === true
}

export async function getFrizzSupervisorStatus(fetcher: typeof fetch = fetch): Promise<FrizzSupervisorStatus | null> {
  try {
    const response = await fetcher("/_frizz/control/status", { headers: { "cache-control": "no-store" } })
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return null
    const status = await response.json() as Partial<FrizzSupervisorStatus>
    return status.protocol === 1 && (status.state === "ready" || status.state === "restarting" || status.state === "failed") ? status as FrizzSupervisorStatus : null
  } catch {
    return null
  }
}

async function requestFrizzRestartAction(path: "/_frizz/control/restart" | "/_frizz/control/update-restart", fetcher: typeof fetch): Promise<RestartFrizzResult> {
  const response = await fetcher(path, {
    method: "POST",
    headers: { "cache-control": "no-store" },
  })
  let result: RestartFrizzResult | undefined
  try {
    result = await response.json() as RestartFrizzResult
  } catch {
    // Keep the failure leg actionable even if an old/non-supervised server returned HTML.
  }
  if (!response.headers.get("content-type")?.includes("application/json") || !result || result.protocol !== 1 || (result.state !== "ready" && result.state !== "restarting" && result.state !== "failed")) {
    throw new Error("Frizz restart controls are unavailable for this server")
  }
  if (!response.ok) {
    throw new Error(result.message ?? `Restart request failed (${response.status})`)
  }
  if (result.state === "failed") throw new Error(result.message ?? "Frizz did not become ready")
  return result
}

/** Restarts the currently promoted artifact through any protocol-compatible supervisor. */
export function requestFrizzRestart(fetcher: typeof fetch = fetch): Promise<RestartFrizzResult> {
  return requestFrizzRestartAction("/_frizz/control/restart", fetcher)
}

/** Reaches the durable frizz-dev supervisor, never the disposable Frizz application child directly. */
export function requestFrizzUpdateRestart(fetcher: typeof fetch = fetch): Promise<RestartFrizzResult> {
  return requestFrizzRestartAction("/_frizz/control/update-restart", fetcher)
}
