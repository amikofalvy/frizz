import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardDelta, ThreadView } from "@frizz/shared"
import { BoardDeltasResult } from "@frizz/shared"
import { DeltaRing } from "./board.ts"
import type { AppContext } from "./context.ts"
import { createRouter } from "./router.ts"

// THE BOARD'S DELTAS OVER HTTP (`boardDeltas`): what the Console polls for a project whose /ws never
// opened (web api/consoleFeed.ts). It answers from the ring a socket's resume replays, so it promises
// what that resume promises: every delta after the seq named, in order, or a resync — never a run with
// a hole in it, and never another boot's deltas.

function delta(seq: number): BoardDelta {
  return { type: "board-delta", seq, bootId: "boot-1", upserts: [{ id: `t${seq}` } as unknown as ThreadView], removed: [] }
}

function harness(maxDeltas?: number) {
  let seq = 0
  const ring = new DeltaRing(() => seq, maxDeltas)
  const ctx = {
    project: { dir: "/p", stateDir: "/p", id: "own" },
    storage: {},
    tailer: {},
    bootId: "boot-1",
    board: { deltasSince: (since: number) => ring.since(since), currentSeq: () => seq },
  } as unknown as AppContext
  const router = createRouter(ctx)
  return {
    publish() {
      ring.remember(delta(++seq))
    },
    ask: async (input: { bootId: string; seq: number }) => {
      const out = await router.boardDeltas.handler({ input })
      // A resync is checked against the schema the client parses by; a delta's threads here are stubs.
      if ("resync" in out) BoardDeltasResult.parse(out)
      return out
    },
  }
}

test("boardDeltas: the deltas after the seq held, in order; none when it is current", async () => {
  const h = harness()
  for (let i = 0; i < 4; i++) h.publish()
  const out = await h.ask({ bootId: "boot-1", seq: 1 })
  assert.ok("deltas" in out)
  assert.deepEqual(out.deltas.map((d) => d.seq), [2, 3, 4])
  assert.equal(out.bootId, "boot-1")
  const current = await h.ask({ bootId: "boot-1", seq: 4 })
  assert.ok("deltas" in current)
  assert.deepEqual(current.deltas, [])
})

test("boardDeltas: a board it cannot carry forward is told to read the board again, and why", async () => {
  const h = harness(3)
  for (let i = 0; i < 6; i++) h.publish()
  assert.deepEqual(await h.ask({ bootId: "boot-0", seq: 6 }), { bootId: "boot-1", resync: "boot" }, "another boot's seq means nothing here")
  assert.deepEqual(await h.ask({ bootId: "boot-1", seq: 1 }), { bootId: "boot-1", resync: "expired" }, "older than the ring")
  assert.deepEqual(await h.ask({ bootId: "boot-1", seq: 9 }), { bootId: "boot-1", resync: "ahead" }, "newer than anything published")
  const edge = await h.ask({ bootId: "boot-1", seq: 3 })
  assert.ok("deltas" in edge && edge.deltas.map((d) => d.seq).join() === "4,5,6", "the oldest seq the ring still covers")
})
