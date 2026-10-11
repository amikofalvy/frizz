// A WORKER KEEPS ITS OWN PLUGIN CURRENT. Nobody presses a button, and the server asks for nothing.
//
// A Claude worker loads its plugin closure — hook registrations, skills, sub-agent profiles — once, when
// its session starts, and the daemon holding that session outlives the Frizz that forked it by hours.
// Frizz publishes the plugin at a path that MOVES when a newer version boots (stable-plugin-path.ts),
// and a source checkout's `cc-worker/` is edited where it stands; either way the files under a running
// worker change while its loaded copy does not. Until 2026-10-11 the only way across that gap was a
// "Reload plugins" button on the thread, which an operator had to know to press on every live thread
// after every update — and which could not help at all, because workers were launched against a
// version-specific directory that never changed.
//
// So the daemon asks the question itself, at the two moments a session is between turns: when a turn
// ENDS, and when an input arrives for a session that is idle. If the plugin's fingerprint has moved
// since the copy this session loaded, it re-reads it in place (`Query.reloadPlugins()`): same process,
// same conversation, same in-memory sub-agents.
//
// BETWEEN TURNS, NEVER DURING ONE. A reload swaps the hook registrations under the session, and a
// tool call that lands while they are being swapped can miss its hook — a permission request the
// policy hook would have settled reaches the operator as a card, a sub-agent launch goes unbound. A
// turn boundary is the one place nothing is in flight to miss. That is also why an input waits behind
// a reload already under way instead of racing it: the turn it starts must see one plugin, not two.
//
// What it does NOT move is an MCP server: a reload reports the plugin's servers and re-spawns none of
// them (measured, plans/live-worker-updates.md §0). The Frizz MCP shim is written so that does not
// matter — it re-resolves the server it talks to on every call.

/** Opt-out, for the day a reload itself is what is breaking workers: `FRIZZ_PLUGIN_SYNC_OFF=1` in the
 *  environment Frizz is started with. Read by the daemon at fork, so it reaches newly started workers. */
export function claudePluginSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FRIZZ_PLUGIN_SYNC_OFF !== "1"
}

// A held input is answered inside the bridge's 30s acknowledgement deadline or the operator's send
// fails, so a reload that has not come back by now is abandoned and the input goes ahead without it.
const RELOAD_DEADLINE_MS = 8_000
// One plugin state gets this many tries. A plugin that cannot be reloaded would otherwise cost a
// failed reload at every turn boundary for the rest of the session.
const RELOAD_ATTEMPTS = 2

export interface ClaudePluginSync {
  /**
   * An input is about to be handed to the session. Resolves when it may go; null means now.
   *
   * `startsTurn` is false for a message addressed to a running sub-agent, which joins a conversation
   * already under way instead of opening a turn on the thread. It still waits behind a reload in
   * flight, and never starts one.
   */
  beforeInput(startsTurn: boolean): Promise<void> | null
  /** Something is about to READ the closure (the composer listing skills). Same check, no turn. */
  beforeRead(): Promise<void> | null
  /** The session produced output, so a turn is running — including one it opened by itself, on a
   *  background task's completion, with no input from anyone. */
  turnActive(): void
  turnEnded(): void
}

export function createClaudePluginSync(deps: {
  /** The plugin as it is on disk right now; undefined when it cannot be read. */
  fingerprint: () => string | undefined
  reload: () => Promise<{ errorCount?: number }>
  log: (message: string) => void
  deadlineMs?: number
}): ClaudePluginSync {
  // What the session is running. Taken before the session starts, so a plugin that moves while the
  // CLI is still reading it costs one redundant reload rather than a missed one.
  let loaded = deps.fingerprint()
  let busy = false
  let inFlight: Promise<void> | null = null
  let failed: { fingerprint: string; attempts: number } | undefined

  const reloadWithinDeadline = (): Promise<{ errorCount?: number }> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the session did not answer in time")), deps.deadlineMs ?? RELOAD_DEADLINE_MS)
    deps.reload().then(
      (result) => { clearTimeout(timer); resolve(result) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })

  const check = (): void => {
    if (inFlight) return
    const current = deps.fingerprint()
    if (current === undefined || current === loaded) return
    if (failed?.fingerprint === current && failed.attempts >= RELOAD_ATTEMPTS) return
    const attempt: Promise<void> = reloadWithinDeadline().then(
      (result) => {
        loaded = current
        failed = undefined
        deps.log(`plugin changed on disk; reloaded in place${result.errorCount ? ` with ${result.errorCount} load error(s)` : ""}`)
      },
      (error: unknown) => {
        failed = { fingerprint: current, attempts: failed?.fingerprint === current ? failed.attempts + 1 : 1 }
        deps.log(`plugin changed on disk but the reload failed (attempt ${failed.attempts}/${RELOAD_ATTEMPTS}): ${error instanceof Error ? error.message : String(error)}`)
      },
    ).finally(() => { if (inFlight === attempt) inFlight = null })
    inFlight = attempt
  }

  return {
    beforeInput(startsTurn) {
      if (startsTurn) {
        if (!busy) check()
        busy = true
      }
      return inFlight
    },
    beforeRead() {
      if (!busy) check()
      return inFlight
    },
    turnActive() { busy = true },
    turnEnded() {
      busy = false
      check()
    },
  }
}
