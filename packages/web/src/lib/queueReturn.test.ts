import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { returningHolds } from "./queueReturn.ts"
import { REST_CATCH_UP_MS, type RestEvidence } from "./steering.ts"

const T = (s: number) => new Date(Date.UTC(2026, 9, 13, 12, 0, s)).toISOString()
const rested = (id: string, lastAssistantAt: string): ThreadView => ({ id, runtime: "turn-idle", lastAssistantAt } as unknown as ThreadView)
const human = (at: string): RestEvidence => ({ role: "user", at })
const said = (at: string): RestEvidence => ({ role: "assistant", at })
const restAt = (at: string): RestEvidence => ({ role: "assistant", kind: "event", boundary: "rest", at })

// The shape measured on the queue page: the card left when the human sent, so its cache stopped at their
// message; the turn's end puts it back in the queue on a board row whose last record is the reply.
const PRE_TURN = [said(T(0)), restAt(T(1)), human(T(5))]
const CAUGHT_UP = [...PRE_TURN, said(T(9)), restAt(T(9))]

const NOW = 1_000_000

test("a card coming back to the queue over the pre-turn cache is held", () => {
  const holds = returningHolds(new Map(), new Set(["neighbour"]), [rested("neighbour", T(1)), rested("back", T(9))], (s) => (s === "back" ? PRE_TURN : [said(T(1))]), NOW)
  assert.deepEqual([...holds], [["back", NOW]])
})

test("…and released by the render that sees the reply, in the cache the queue card will mount from", () => {
  const prior = new Map([["back", NOW]])
  const items = [rested("back", T(9))]
  assert.deepEqual([...returningHolds(prior, new Set(["back"]), items, () => PRE_TURN, NOW + 30)], [["back", NOW]], "still behind: the hold carries its start forward")
  assert.equal(returningHolds(prior, new Set(["back"]), items, () => CAUGHT_UP, NOW + 31).size, 0)
})

test("a hold never outlives REST_CATCH_UP_MS, whether or not the transcript ever arrives", () => {
  const prior = new Map([["back", NOW]])
  const items = [rested("back", T(9))]
  assert.equal(returningHolds(prior, new Set(["back"]), items, () => PRE_TURN, NOW + REST_CATCH_UP_MS - 1).size, 1)
  assert.equal(returningHolds(prior, new Set(["back"]), items, () => PRE_TURN, NOW + REST_CATCH_UP_MS).size, 0)
})

test("a card whose transcript is already caught up enters at once", () => {
  assert.equal(returningHolds(new Map(), new Set(), [rested("back", T(9))], () => CAUGHT_UP, NOW).size, 0)
})

test("a card that never had a transcript is held for its first read, not drawn from its status line", () => {
  assert.deepEqual([...returningHolds(new Map(), new Set(), [rested("fresh", T(9))], () => undefined, NOW)], [["fresh", NOW]])
})

test("the cards a page opens on are never held — only ones ENTERING a queue that has already rendered", () => {
  assert.equal(returningHolds(new Map(), null, [rested("back", T(9))], () => PRE_TURN, NOW).size, 0)
  // Already on screen in the previous render: it is not entering, whatever its cache says.
  assert.equal(returningHolds(new Map(), new Set(["back"]), [rested("back", T(9))], () => PRE_TURN, NOW).size, 0)
})

test("a released card is not held again by a later render", () => {
  // Released (absent from prior) and already known: the next render leaves it in the list.
  assert.equal(returningHolds(new Map(), new Set(["back"]), [rested("back", T(9))], () => PRE_TURN, NOW + REST_CATCH_UP_MS + 5).size, 0)
})

test("a held card the board takes back out of the queue stops being held", () => {
  assert.equal(returningHolds(new Map([["back", NOW]]), new Set(["back"]), [], () => PRE_TURN, NOW + 10).size, 0)
})
