import assert from "node:assert/strict"
import { test } from "node:test"
import { claudePluginSyncEnabled, createClaudePluginSync } from "./claude-plugin-sync.ts"

/** A plugin whose fingerprint the test moves by hand, and a reload it settles by hand. */
function harness(options: { deadlineMs?: number } = {}) {
  const state = { fingerprint: "v1" as string | undefined, reloads: 0, log: [] as string[] }
  let settle: { resolve: (value: { errorCount?: number }) => void; reject: (error: Error) => void } | undefined
  const sync = createClaudePluginSync({
    fingerprint: () => state.fingerprint,
    reload: () => new Promise((resolve, reject) => { state.reloads++; settle = { resolve, reject } }),
    log: (message) => state.log.push(message),
    deadlineMs: options.deadlineMs,
  })
  return {
    sync, state,
    finishReload: (errorCount = 0) => settle!.resolve({ errorCount }),
    failReload: (message: string) => settle!.reject(new Error(message)),
  }
}

test("an unchanged plugin never costs a reload, at an input or at a turn end", () => {
  const h = harness()
  assert.equal(h.sync.beforeInput(true), null, "the input goes straight through")
  h.sync.turnEnded()
  assert.equal(h.sync.beforeRead(), null)
  assert.equal(h.state.reloads, 0)
})

test("a plugin that moved while the session was idle is reloaded before the next input, which waits for it", async () => {
  const h = harness()
  h.state.fingerprint = "v2"
  const held = h.sync.beforeInput(true)
  assert.ok(held, "the input is held behind the reload")
  assert.equal(h.state.reloads, 1)

  let released = false
  void held.then(() => { released = true })
  await Promise.resolve()
  assert.equal(released, false, "and stays held until the session has answered")
  h.finishReload()
  await held
  assert.equal(released, true)

  // The session is on v2 now; nothing reloads again until the plugin moves again.
  h.sync.turnEnded()
  assert.equal(h.sync.beforeInput(true), null)
  assert.equal(h.state.reloads, 1)
})

test("a plugin that moved DURING a turn waits for the turn to end", async () => {
  const h = harness()
  assert.equal(h.sync.beforeInput(true), null)
  h.state.fingerprint = "v2"
  // A steer into the running turn: mid-turn, so no reload starts and nothing is held.
  assert.equal(h.sync.beforeInput(true), null)
  assert.equal(h.sync.beforeRead(), null)
  assert.equal(h.state.reloads, 0, "never during a turn")

  h.sync.turnEnded()
  assert.equal(h.state.reloads, 1, "at the boundary")
  h.finishReload()
  await h.sync.beforeRead()
})

test("a turn the session opened by itself counts as a turn", () => {
  const h = harness()
  h.sync.turnActive() // output with no input from anyone: a background task's completion woke it
  h.state.fingerprint = "v2"
  assert.equal(h.sync.beforeInput(true), null)
  assert.equal(h.state.reloads, 0)
  h.sync.turnEnded()
  assert.equal(h.state.reloads, 1)
})

test("inputs that arrive behind one reload are released together, in arrival order", async () => {
  const h = harness()
  h.state.fingerprint = "v2"
  const order: string[] = []
  const first = h.sync.beforeInput(true)!
  const second = h.sync.beforeInput(true)!
  const addressed = h.sync.beforeInput(false)!
  void first.then(() => order.push("first"))
  void second.then(() => order.push("second"))
  void addressed.then(() => order.push("addressed"))
  assert.equal(h.state.reloads, 1, "one reload, however many inputs are waiting on it")
  h.finishReload()
  await addressed
  assert.deepEqual(order, ["first", "second", "addressed"])
})

test("a message addressed to a sub-agent never starts a reload and never opens a turn", () => {
  const h = harness()
  h.state.fingerprint = "v2"
  assert.equal(h.sync.beforeInput(false), null)
  assert.equal(h.state.reloads, 0)
  // The thread itself is still idle, so its next real input is what catches it up.
  assert.ok(h.sync.beforeInput(true))
  assert.equal(h.state.reloads, 1)
})

test("a plugin that cannot be read is never a reason to reload", () => {
  const h = harness()
  h.state.fingerprint = undefined // the link is mid-repoint, or the tree is being rewritten
  assert.equal(h.sync.beforeInput(true), null)
  h.sync.turnEnded()
  assert.equal(h.state.reloads, 0)
})

test("a failed reload releases the input, is retried once at the next boundary, then left alone", async () => {
  const h = harness()
  h.state.fingerprint = "v2"
  const held = h.sync.beforeInput(true)!
  h.failReload("plugins could not be reloaded")
  await held // released, not rejected: a reload that failed must not cost the operator their message
  assert.match(h.state.log.at(-1)!, /reload failed \(attempt 1\/2\): plugins could not be reloaded/)

  h.sync.turnEnded()
  assert.equal(h.state.reloads, 2, "one retry")
  h.failReload("still broken")
  await h.sync.beforeRead()

  h.sync.turnEnded()
  assert.equal(h.sync.beforeInput(true), null)
  assert.equal(h.state.reloads, 2, "the same broken plugin is not retried at every boundary for the rest of the session")

  // A DIFFERENT plugin state is a new question and gets its own tries.
  h.sync.turnEnded()
  h.state.fingerprint = "v3"
  assert.ok(h.sync.beforeInput(true))
  assert.equal(h.state.reloads, 3)
})

test("a reload that never answers is abandoned at the deadline, so a held input still goes", async () => {
  const h = harness({ deadlineMs: 20 })
  h.state.fingerprint = "v2"
  const held = h.sync.beforeInput(true)!
  await held
  assert.match(h.state.log.at(-1)!, /did not answer in time/)
})

test("a successful reload says so, and names load errors when there are any", async () => {
  const h = harness()
  h.state.fingerprint = "v2"
  const held = h.sync.beforeInput(true)!
  h.finishReload(2)
  await held
  assert.match(h.state.log.at(-1)!, /reloaded in place with 2 load error\(s\)/)
})

test("FRIZZ_PLUGIN_SYNC_OFF=1 is the opt-out, and nothing else is", () => {
  assert.equal(claudePluginSyncEnabled({}), true)
  assert.equal(claudePluginSyncEnabled({ FRIZZ_PLUGIN_SYNC_OFF: "0" }), true)
  assert.equal(claudePluginSyncEnabled({ FRIZZ_PLUGIN_SYNC_OFF: "1" }), false)
})
