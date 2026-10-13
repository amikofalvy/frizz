import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { turnAheadKey, type TurnAheadEvidence } from "./queueTurnAhead.ts"

const rested = { id: "t", runtime: "turn-idle", needsYou: true } as unknown as ThreadView
const running = { id: "t", runtime: "running" } as unknown as ThreadView
const user = (sourceId: string, over: Partial<TurnAheadEvidence> = {}): TurnAheadEvidence => ({ role: "user", sourceId, ...over })
const reply = (sourceId: string): TurnAheadEvidence => ({ role: "assistant", sourceId })
const rest = (sourceId: string): TurnAheadEvidence => ({ role: "assistant", kind: "event", boundary: "rest", sourceId })

test("a landed message after the rest the board still reports is a turn ahead of the board, named by that message", () => {
  const atRest = [user("u1"), reply("a1"), rest("r1")]
  assert.equal(turnAheadKey(rested, atRest), undefined)
  assert.equal(turnAheadKey(rested, [...atRest, user("u2")]), "u2")
  // Once the worker has said anything under it, the rest the board reports may be that turn's own end
  // (transcriptPastRest's rule), so nothing is held: with or without the boundary that closes it.
  assert.equal(turnAheadKey(rested, [...atRest, user("u2"), reply("a2")]), undefined)
  assert.equal(turnAheadKey(rested, [...atRest, user("u2"), reply("a2"), rest("r2")]), undefined)
})

test("nothing is ahead once the board reports the turn, before a transcript loads, or for a send nobody was handed", () => {
  const atRest = [user("u1"), reply("a1"), rest("r1")]
  assert.equal(turnAheadKey(running, [...atRest, user("u2")]), undefined)
  assert.equal(turnAheadKey(rested, undefined), undefined)
  assert.equal(turnAheadKey(undefined, [...atRest, user("u2")]), undefined)
  // This tab's own optimistic bubble, and a send that failed or is being held: not a turn.
  assert.equal(turnAheadKey(rested, [...atRest, user("ghost", { queued: true })]), undefined)
  assert.equal(turnAheadKey(rested, [...atRest, user("f", { deliveryState: "failed" })]), undefined)
  assert.equal(turnAheadKey(rested, [...atRest, user("h", { deliveryState: "held" })]), undefined)
  // A landed message under a ghost is still the opener.
  assert.equal(turnAheadKey(rested, [...atRest, user("u2"), user("ghost", { queued: true })]), "u2")
})
