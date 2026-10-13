import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDispatcher, fallbackTitle, slugify } from "./dispatch.ts"
import { createStorage, type SessionLifecycleEvent } from "./storage.ts"
import { defaultSettings } from "./settings.ts"
import { cwdSlug, type Project } from "./project.ts"
import type { BoardManager } from "./board.ts"
import type { ClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"
import type { CodexAppServerBridge } from "./backend/codex-app-server.ts"
import type { AcpBridge } from "./backend/acp-bridge.ts"

// TWO DISPATCHES IN FLIGHT AT ONCE MUST NOT MINT ONE SLUG.
//
// A dispatch resolves its slug, then AWAITS the backend spawn (seconds), and only then writes its row.
// Two dispatches whose prompts open with the same words used to both find the base slug free inside
// that window, so the second row REPLACED the first: both workers ran, one thread showed on the board,
// and the first worker's detached daemon kept burning quota with no row pointing at it (seen twice on
// a test stack, 2026-10-13, two `dispatch` RPCs a second apart). Every transport has the window, so
// every transport is driven here with a spawn that resolves only after BOTH dispatches have started.

type Backend = "claude" | "codex" | "acp"

function deferred() {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-slug-race-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const project: Project = { dir, id: "slug-race", name: "t", label: "o/t", stateDir: dir, cwdSlug: cwdSlug(dir) }
  const board = {
    snapshot: async () => ({}),
    currentSeq: () => 0,
    rebuild: async () => {},
    refresh: () => ({}),
    start: async () => {},
    stop: async () => {},
  } as unknown as BoardManager
  // Every spawn parks on its own gate, so the test decides when each one returns — and records the
  // slug it was asked to spawn, which is the slug a real daemon would be bound to.
  const spawns: { slug: string; gate: ReturnType<typeof deferred> }[] = []
  const spawn = async (threadSlug: string) => {
    const gate = deferred()
    spawns.push({ slug: threadSlug, gate })
    await gate.promise
  }
  const claudeBroker = {
    spawnDispatch: async (input: { threadSlug: string; sessionId: string; cwd: string }) => {
      await spawn(input.threadSlug)
      return { binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd } }
    },
    releaseSession: () => {},
  } as unknown as ClaudeAgentBrokerBridge
  const codexAppServer = {
    spawnDispatch: async (input: { threadSlug: string; sessionId: string }) => {
      await spawn(input.threadSlug)
      return { binding: { codexSessionId: `codex-${input.sessionId}` }, turnId: "turn-1" }
    },
    releaseSession: () => {},
  } as unknown as CodexAppServerBridge
  const acpBridge = {
    spawnDispatch: async (input: { threadSlug: string; sessionId: string }) => {
      await spawn(input.threadSlug)
      return { acpSessionId: `acp-${input.sessionId}` }
    },
    releaseSession: () => {},
  } as unknown as AcpBridge
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    getSettings: () => ({ ...defaultSettings(), model: "sonnet", effort: "high" }),
    claudeBroker,
    codexAppServer,
    acpBridge,
  })
  const lifecycle: SessionLifecycleEvent[] = []
  storage.subscribeSessionLifecycle((event) => void lifecycle.push(event))
  return { storage, dispatcher, spawns, lifecycle }
}

// Yield until the fake has seen `n` spawns (each dispatch reaches its spawn after a few microtasks:
// the preflights are absent here, so nothing else is awaited first).
async function spawnsReach(spawns: unknown[], n: number) {
  for (let i = 0; i < 1000 && spawns.length < n; i++) await new Promise((r) => setImmediate(r))
  assert.equal(spawns.length, n, `expected ${n} spawn(s) in flight`)
}

function dispatchArgs(backend: Backend) {
  return backend === "acp" ? { model: "acp:gemini" } : {}
}

const PROMPT_A = "Fix the flaky resolver test in the board package"
const PROMPT_B = "Fix the flaky resolver test in the tailer instead"

for (const backend of ["claude", "codex", "acp"] as const) {
  test(`${backend}: two overlapping dispatches with the same opening words get distinct slugs and both rows`, async () => {
    const { storage, dispatcher, spawns, lifecycle } = harness()
    try {
      const a = dispatcher.dispatch({ prompt: PROMPT_A, ...dispatchArgs(backend) }, { backend })
      await spawnsReach(spawns, 1)
      // A is now parked inside its spawn with NO row written: exactly the window the race lived in.
      const b = dispatcher.dispatch({ prompt: PROMPT_B, ...dispatchArgs(backend) }, { backend })
      await spawnsReach(spawns, 2)
      for (const s of spawns) s.gate.resolve()
      const [ra, rb] = await Promise.all([a, b])

      assert.deepEqual(lifecycle.filter((e) => e.type === "replaced"), [], "no row may replace another")
      assert.notEqual(ra.slug, rb.slug)
      assert.notEqual(spawns[0].slug, spawns[1].slug, "the second worker must not be bound to the first one's slug")
      assert.equal(rb.slug, `${ra.slug}-2`, "the later dispatch takes the usual collision suffix")
      assert.equal(storage.getSession(ra.slug)?.session_id, ra.sessionId, "the first thread's row survives")
      assert.equal(storage.getSession(rb.slug)?.session_id, rb.sessionId)
    } finally {
      storage.close()
    }
  })
}

test("an explicit slug already in flight collides and suffixes, exactly like one already on the board", async () => {
  const { storage, dispatcher, spawns, lifecycle } = harness()
  try {
    const a = dispatcher.dispatch({ prompt: "one", slug: "pinned-slug" })
    await spawnsReach(spawns, 1)
    const b = dispatcher.dispatch({ prompt: "two", slug: "pinned-slug" })
    await spawnsReach(spawns, 2)
    for (const s of spawns) s.gate.resolve()
    const [ra, rb] = await Promise.all([a, b])
    assert.equal(ra.slug, "pinned-slug")
    assert.equal(rb.slug, "pinned-slug-2")
    assert.deepEqual(lifecycle.filter((e) => e.type === "replaced"), [])
  } finally {
    storage.close()
  }
})

test("a failed spawn releases its slug, so a later dispatch takes the base slug", async () => {
  const { storage, dispatcher, spawns } = harness()
  try {
    const a = dispatcher.dispatch({ prompt: PROMPT_A })
    await spawnsReach(spawns, 1)
    const base = spawns[0].slug
    // While A is in flight its slug is reserved: B is pushed to the suffix.
    const b = dispatcher.dispatch({ prompt: PROMPT_B })
    await spawnsReach(spawns, 2)
    assert.equal(spawns[1].slug, `${base}-2`)
    spawns[0].gate.reject(new Error("daemon exited before it became ready"))
    await assert.rejects(a, /could not start this thread/)
    assert.equal(storage.getSession(base), undefined, "a failed dispatch writes no row")

    // A is gone, so its slug is free again — and B's suffix is still held while B is in flight.
    const c = dispatcher.dispatch({ prompt: PROMPT_A })
    await spawnsReach(spawns, 3)
    assert.equal(spawns[2].slug, base, "the failed dispatch's reservation must not outlive it")
    spawns[1].gate.resolve()
    spawns[2].gate.resolve()
    const [rb, rc] = await Promise.all([b, c])
    assert.equal(rb.slug, `${base}-2`)
    assert.equal(rc.slug, base)
  } finally {
    storage.close()
  }
})

test("a dispatch refused before its spawn releases its slug too", async () => {
  const { storage, dispatcher, spawns } = harness()
  try {
    // An ACP dispatch with no `acp:<agent>` model is refused AFTER its slug resolved but BEFORE any
    // spawn — a throw on a path that never reaches the backend must release the slug as well.
    await assert.rejects(dispatcher.dispatch({ prompt: PROMPT_A }, { backend: "acp" }), /needs an agent/)
    const p = dispatcher.dispatch({ prompt: PROMPT_A })
    await spawnsReach(spawns, 1)
    spawns[0].gate.resolve()
    const { slug } = await p
    assert.equal(slug, slugify(fallbackTitle(PROMPT_A)), "the refused dispatch must not still hold the base slug")
  } finally {
    storage.close()
  }
})
