import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardSnapshot, BoardState } from "@frizz/shared"
import { BoardResume } from "./board-resume.ts"

// WHEN the board is read and WHAT a socket is told to resume from (board-resume.ts). The feed here is a
// fake that holds a (boot, seq) and records every read and every resume it is asked to send.

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

function harness() {
  const reads: { resolve: (s: BoardState) => void; reject: (e: Error) => void }[] = []
  const sent: { bootId: string; seq: number }[] = []
  let held: { bootId: string; seq: number } | null = null
  const resume = new BoardResume({
    read: () => new Promise<BoardState>((resolve, reject) => reads.push({ resolve, reject })),
    adopt: (state) => {
      if (held && held.bootId === state.bootId && held.seq >= state.seq) return true
      held = { bootId: state.bootId, seq: state.seq }
      return true
    },
    held: () => held,
    send: (bootId, seq) => sent.push({ bootId, seq }),
  })
  const land = async (seq: number, bootId = "b1") => {
    const read = reads.shift()
    assert.ok(read, "a read is in flight")
    read.resolve({ board: {} as BoardSnapshot, seq, bootId })
    await settle()
  }
  return { resume, reads, sent, land, hold: (seq: number, bootId = "b1") => { held = { bootId, seq } }, held: () => held }
}

test("board resume: a read that lands before the hello is named on it; one that lands after, once it does", async () => {
  const early = harness()
  early.resume.prefetch()
  await early.land(4)
  assert.deepEqual(early.sent, [], "no socket yet")
  early.resume.hello("b1")
  assert.deepEqual(early.sent, [{ bootId: "b1", seq: 4 }])
  assert.equal(early.reads.length, 0, "one read in all")

  const late = harness()
  late.resume.prefetch()
  late.resume.hello("b1")
  assert.deepEqual(late.sent, [], "nothing to name while the read is in flight")
  assert.equal(late.reads.length, 1, "and the hello does not start a second read")
  await late.land(4)
  assert.deepEqual(late.sent, [{ bootId: "b1", seq: 4 }])
})

test("board resume: a drop keeps the seq; the next hello names it without a read", async () => {
  const h = harness()
  h.resume.prefetch()
  await h.land(4)
  h.resume.hello("b1")
  h.hold(9) // deltas applied on that socket
  h.resume.dropped()
  h.resume.hello("b1")
  assert.deepEqual(h.sent.at(-1), { bootId: "b1", seq: 9 })
  assert.equal(h.reads.length, 0)
})

test("board resume: a hello from another boot reads the board before naming anything", async () => {
  const h = harness()
  h.hold(40, "b1")
  h.resume.hello("b2")
  assert.deepEqual(h.sent, [], "a seq from boot b1 means nothing to b2")
  await h.land(3, "b2")
  assert.deepEqual(h.sent, [{ bootId: "b2", seq: 3 }])
})

test("board resume: a resync reads once however often it is asked, and a read never steps the board back", async () => {
  const h = harness()
  h.hold(5)
  h.resume.hello("b1")
  h.resume.resync()
  h.resume.resync()
  h.resume.resync()
  assert.equal(h.reads.length, 1, "one read in flight at a time")
  // While it was in flight the socket carried the board past what the read will say.
  h.hold(8)
  await h.land(6)
  assert.deepEqual(h.held(), { bootId: "b1", seq: 8 }, "the held board is newer; the read does not replace it")
  assert.deepEqual(h.sent.at(-1), { bootId: "b1", seq: 8 })
})

test("board resume: nothing is named after the socket dropped, until the next hello", async () => {
  const h = harness()
  h.resume.hello("b1")
  h.resume.dropped()
  await h.land(4)
  assert.deepEqual(h.sent, [])
  h.resume.hello("b1")
  assert.deepEqual(h.sent, [{ bootId: "b1", seq: 4 }])
})

test("board resume: reads past the second without progress back off; progress or a hello clears it", async () => {
  const timers: { delay: number; run: () => void }[] = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((run: () => void, delay: number) => {
    timers.push({ delay, run })
    return timers.length as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  try {
    const h = harness()
    h.resume.hello("b1") // nothing held: read
    assert.equal(h.reads.length, 1)
    h.reads.shift()!.reject(new Error("offline"))
    await settle()
    assert.equal(h.reads.length, 1, "the second read goes at once")
    h.reads.shift()!.reject(new Error("offline"))
    await settle()
    assert.equal(h.reads.length, 0, "the third waits")
    assert.equal(timers.at(-1)?.delay, 500)
    timers.at(-1)!.run()
    h.reads.shift()!.reject(new Error("offline"))
    await settle()
    assert.equal(timers.at(-1)?.delay, 1_000, "and doubles")
    timers.at(-1)!.run()
    await h.land(7)
    assert.deepEqual(h.sent, [{ bootId: "b1", seq: 7 }])
    h.resume.progressed()
    h.resume.resync()
    assert.equal(h.reads.length, 1, "after progress, the next disagreement reads at once")
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})

test("board resume: a reset discards a read in flight", async () => {
  const h = harness()
  h.resume.prefetch()
  h.resume.hello("b1")
  const stale = h.reads.shift()!
  h.resume.reset()
  stale.resolve({ board: {} as BoardSnapshot, seq: 99, bootId: "b1" })
  await settle()
  assert.equal(h.held(), null, "the read was for what the feed showed before the reset")
  assert.deepEqual(h.sent, [])
  h.resume.prefetch()
  await h.land(2)
  h.resume.hello("b1")
  assert.deepEqual(h.sent, [{ bootId: "b1", seq: 2 }])
})
