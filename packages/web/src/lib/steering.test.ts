import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { isOptimisticallySteering, optimisticallySteered, steeredSinceRest, STEER_OPTIMISM_MS, transcriptBehindRest, transcriptBehindTurn, transcriptHold, transcriptPastRest } from "./steering.ts"
import { isActivelyRunning, isSnoozed, orderActive, partitionActive, sectionOf, sessionIndicatorKind } from "../groups.ts"

const at = (lastActivityAt?: string) => ({ id: "t", lastActivityAt } as unknown as ThreadView)

test("a fresh steer renders as working before the server has said anything", () => {
  const sent = 1_000_000
  // Board activity predating the steer is exactly the stale reading the hint exists to cover.
  assert.equal(isOptimisticallySteering(at(new Date(sent - 5_000).toISOString()), sent, sent + 200), true)
  assert.equal(isOptimisticallySteering(at(undefined), sent, sent + 200), true)
})

test("server truth reclaims the row as soon as it is newer than the steer", () => {
  const sent = 1_000_000
  // Any activity stamped after the send means the tailer has looked since — whatever it reports now
  // (running, or already finished and back at rest) beats the guess.
  assert.equal(isOptimisticallySteering(at(new Date(sent + 1).toISOString()), sent, sent + 200), false)
})

test("the hint expires rather than spinning forever on a steer that produced nothing", () => {
  const sent = 1_000_000
  assert.equal(isOptimisticallySteering(at(undefined), sent, sent + STEER_OPTIMISM_MS - 1), true)
  assert.equal(isOptimisticallySteering(at(undefined), sent, sent + STEER_OPTIMISM_MS + 1), false)
})

test("a thread that was never steered is untouched", () => {
  assert.equal(isOptimisticallySteering(at(undefined), undefined, 1_000_000), false)
})

test("an unparseable activity stamp falls back to the hint rather than throwing it away", () => {
  const sent = 1_000_000
  assert.equal(isOptimisticallySteering(at("not-a-date"), sent, sent + 200), true)
})

// ── the overlay ───────────────────────────────────────────────────────────────────────────────────
// The spinner was never the point on its own: the rail's SECTION and BAND are derived, so a hint the
// indicator alone consulted left the row spinning inside the queue-ordered rested band until the
// tailer caught up. These pin that one overlay drives every derivation.

const SENT = 1_000_000
const queued = (over: Partial<ThreadView> = {}) =>
  ({
    id: "t",
    kind: "session",
    state: "open",
    status: "active",
    runtime: "turn-idle",
    needsYou: true,
    pendingQuestion: true,
    spawnedAt: new Date(SENT - 600_000).toISOString(),
    lastUserAt: new Date(SENT - 600_000).toISOString(),
    ...over,
  }) as unknown as ThreadView

test("a steered row reads as running to every rail predicate, not just the indicator", () => {
  const t = optimisticallySteered(queued(), SENT, SENT + 200)
  assert.equal(isActivelyRunning(t), true)
  assert.equal(sectionOf(t), "active")
  assert.equal(sessionIndicatorKind(t), "working")
  // The band split is `isActivelyRunning && needsYou !== true` — clearing the queue reasons the steer
  // just answered is what actually moves the row out of the rested run.
  assert.deepEqual(partitionActive(orderActive([t])).running.map((x) => x.id), ["t"])
})

test("a steered row sorts to the top of the running band, where server truth will also put it", () => {
  // The running band orders by user recency. Without the lastUserAt bump the row would enter at its
  // stale position and then hop again when the server reported this same instant.
  const older = queued({ id: "older", runtime: "running", needsYou: false, pendingQuestion: false, lastUserAt: new Date(SENT - 60_000).toISOString() })
  const steered = optimisticallySteered(queued(), SENT, SENT + 200)
  assert.deepEqual(orderActive([older, steered]).map((t) => t.id), ["t", "older"])
})

test("a steered row leaves the dimmed Snoozed band, exactly as a real turn start would", () => {
  const snoozed = queued({ needsYou: false, pendingQuestion: false, snoozedUntil: new Date(SENT + 6 * 3_600_000).toISOString() })
  assert.equal(isSnoozed(snoozed, SENT + 200), true)
  assert.equal(isSnoozed(optimisticallySteered(snoozed, SENT, SENT + 200), SENT + 200), false)
})

test("the overlay yields — expired, unsteered, and newer-server-truth rows come back BY IDENTITY", () => {
  const t = queued()
  assert.equal(optimisticallySteered(t, undefined, SENT + 200), t)
  assert.equal(optimisticallySteered(t, SENT, SENT + STEER_OPTIMISM_MS + 1), t)
  const answered = queued({ lastActivityAt: new Date(SENT + 1).toISOString() })
  assert.equal(optimisticallySteered(answered, SENT, SENT + 200), answered)
})

test("the overlay never writes lastActivityAt — that is the evidence it yields to", () => {
  // Writing it would make the hint self-sealing: isOptimisticallySteering would then read its own
  // stamp as proof the server had spoken, and the row could never be reclaimed by truth.
  const t = optimisticallySteered(queued({ lastActivityAt: new Date(SENT - 5_000).toISOString() }), SENT, SENT + 200)
  assert.equal(t.lastActivityAt, new Date(SENT - 5_000).toISOString())
  assert.equal(isOptimisticallySteering(t, SENT, SENT + 400), true)
})

// ── the server's own assertion ────────────────────────────────────────────────────────────────────
// The local stamp lives 12s in the one tab that sent the message. `deliveryInFlight` is the server
// saying the same thing — message stored, turn not started — so every tab, a reload, and a delivery
// slower than the hint draw the row as working instead of as an at-rest row in the Running band.

test("the server's in-flight flag takes the overlay with no local stamp at all", () => {
  // The server only raises it once the queue has let the thread go, so needsYou is already false.
  const rested = queued({ needsYou: false, pendingQuestion: false, deliveryInFlight: true })
  const t = optimisticallySteered(rested, undefined, SENT + 60_000)
  assert.equal(sessionIndicatorKind(t), "working")
  assert.deepEqual(partitionActive(orderActive([t])).running.map((x) => x.id), ["t"])
  // It knows no instant, so it leaves the ordering to the server's own reading.
  assert.equal(t.lastUserAt, rested.lastUserAt)
})

test("…and outlives the local hint, which is the whole reason it exists", () => {
  const rested = queued({ needsYou: false, pendingQuestion: false, deliveryInFlight: true })
  assert.equal(optimisticallySteered(rested, SENT, SENT + STEER_OPTIMISM_MS + 1).runtime, "running")
  // Control: the same row without the flag is back to its at-rest reading once the hint expires.
  const bare = queued({ needsYou: false, pendingQuestion: false })
  assert.equal(optimisticallySteered(bare, SENT, SENT + STEER_OPTIMISM_MS + 1), bare)
})

// ── the thread view's reading ─────────────────────────────────────────────────────────────────────
// The thread view draws the ghost bubble AND the rest's card, so it ends the rest on the bubble rather
// than on the stamp: the card goes in the render that draws the bubble, never before it and never
// seconds after it (2026-10-13).

const rest = { role: "assistant", text: "```awaiting\nprs: [a/b#1]\nstatus: watching\nfor: 1d\n```" } as const
const ghost = { role: "user", queued: true } as const
const landed = { role: "user", at: new Date(SENT + 300).toISOString() } as const
const atRest = (over: Partial<ThreadView> = {}) => queued({ needsYou: false, pendingQuestion: false, lastActivityAt: new Date(SENT - 5_000).toISOString(), ...over })

test("the ghost bubble ends the rest on its own — no stamp, no server flag", () => {
  const t = steeredSinceRest(atRest(), [rest, ghost], 0, undefined, SENT + 200)!
  assert.equal(t.runtime, "running")
  assert.equal(isActivelyRunning(t), true)
})

test("the stamp alone does not: the rest holds until the transcript draws the human's turn", () => {
  const t = atRest()
  assert.equal(steeredSinceRest(t, [rest], 0, SENT, SENT + 200), t)
})

test("a landed turn keeps the rest ended while the steer behind it is live, and only then", () => {
  assert.equal(steeredSinceRest(atRest(), [rest, landed], 0, SENT, SENT + 400)!.runtime, "running")
  assert.equal(steeredSinceRest(atRest({ deliveryInFlight: true }), [rest, landed], 0, undefined, SENT + 60_000)!.runtime, "running")
  // A stalled thread whose last word is the human's, with nothing on its way, is still at rest.
  const stalled = atRest()
  assert.equal(steeredSinceRest(stalled, [rest, landed], 0, undefined, SENT + 400), stalled)
  assert.equal(steeredSinceRest(stalled, [rest, landed], 0, SENT, SENT + STEER_OPTIMISM_MS + 1), stalled)
})

test("only the human's own send counts, and only one still on its way", () => {
  const t = atRest()
  for (const m of [
    { role: "user", queued: true, deliveryState: "failed" },
    { role: "user", queued: true, deliveryState: "unconfirmed" },
    { role: "user", queued: true, deliveryState: "held" },
    { role: "user", queued: true, wake: true },
    { role: "user", queued: true, sessionPeer: { slug: "x" } },
    { role: "user", queued: true, peerFrom: "child" },
  ] as const) assert.equal(steeredSinceRest(t, [rest, m as never], 0, undefined, SENT + 200), t, JSON.stringify(m))
  // A send BEFORE the rest is history, not a new turn.
  assert.equal(steeredSinceRest(t, [ghost, rest], 1, undefined, SENT + 200), t)
})

test("only a rest ends this way: a thread mid-turn keeps its own reading", () => {
  const prompt = atRest({ runtime: "perm-prompt", actionableInteraction: true })
  assert.equal(steeredSinceRest(prompt, [rest, ghost], 0, SENT, SENT + 200), prompt)
  assert.equal(steeredSinceRest(undefined, [rest, ghost], 0, SENT, SENT + 200), undefined)
  assert.equal(steeredSinceRest(atRest({ runtime: "exited" }), [rest, ghost], 0, undefined, SENT + 200)!.runtime, "running")
})

test("the Working clock starts at the send: this tab's stamp, else the server's projected bubble", () => {
  assert.equal(steeredSinceRest(atRest(), [rest, ghost], 0, SENT, SENT + 200)!.lastUserAt, new Date(SENT).toISOString())
  const projected = { role: "user", queued: true, deliveryState: "pending", at: new Date(SENT + 50).toISOString() } as const
  assert.equal(steeredSinceRest(atRest(), [rest, projected], 0, undefined, SENT + 200)!.lastUserAt, projected.at)
})

// A steer that waited out a turn: the board reports the rest ~20ms before the transcript carries the reply.
// The ghost there has ended no rest — the turn on screen is still the one it is waiting on — so the overlay
// (and the Working clock it would re-base on the steer's own instant) stays out of it.
test("a ghost waiting on a turn whose end the transcript has not reached ends nothing", () => {
  const at = (s: number) => new Date(SENT + s * 1000).toISOString()
  const opener = { role: "user", at: at(0) } as const
  const waiting = { role: "user", queued: true, at: at(2) } as const
  const justRested = atRest({ lastAssistantAt: at(6), deliveryInFlight: true })
  assert.equal(steeredSinceRest(justRested, [{ role: "assistant", at: at(-9) }, opener, waiting], 0, SENT + 2_000, SENT + 6_050), justRested)
  // Once the reply and its rest boundary are there, the same ghost is the send that ends that rest — even
  // where the coalesced reply carries an earlier instant than the board's, and the ghost none at all.
  const reply = { role: "assistant", at: at(5) } as const
  const boundary = { role: "assistant", kind: "event", boundary: "rest", at: at(5) } as const
  assert.equal(steeredSinceRest(justRested, [opener, reply, boundary, waiting], 1, undefined, SENT + 6_100)!.runtime, "running")
  assert.equal(steeredSinceRest(justRested, [opener, reply, boundary, { role: "user", queued: true }], 1, undefined, SENT + 6_100)!.runtime, "running")
})

// ── the rest the transcript has not reached ─────────────────────────────────────────────────────────
// The board's turn-idle leads the transcript push carrying the reply by ~20ms; in between the view must
// not draw a rest that has nothing under it.
{
  const rested = (lastAssistantAt: string, runtime: ThreadView["runtime"] = "turn-idle") => ({ id: "t", runtime, lastAssistantAt } as unknown as ThreadView)
  const said = (at: string) => ({ role: "assistant" as const, at })
  const human = (at: string) => ({ role: "user" as const, at })
  const restAt = (at: string) => ({ role: "assistant" as const, kind: "event" as const, boundary: "rest" as const, at })
  const T = (s: number) => new Date(Date.UTC(2026, 9, 13, 11, 0, s)).toISOString()

  test("a rest whose reply the transcript does not carry yet is ahead of it", () => {
    assert.equal(transcriptBehindRest(rested(T(9)), [said(T(0)), restAt(T(1)), human(T(5))]), true)
    // …a turn that had already said something, too: the board's newest record is newer still.
    assert.equal(transcriptBehindRest(rested(T(9)), [said(T(0)), restAt(T(1)), human(T(5)), said(T(7))]), true)
  })

  test("the reply landing catches it up — by its instant, or by the rest boundary that closes the turn", () => {
    assert.equal(transcriptBehindRest(rested(T(9)), [human(T(5)), said(T(9)), restAt(T(9))]), false)
    // A coalesced message can carry its FIRST record's instant while the board names its last one: the
    // projection's own rest boundary still says the transcript has reached the rest.
    assert.equal(transcriptBehindRest(rested(T(9)), [human(T(5)), said(T(8)), restAt(T(8))]), false)
    // A rest guessed without a boundary is caught up once the record itself is there.
    assert.equal(transcriptBehindRest(rested(T(9)), [human(T(5)), said(T(9))]), false)
  })

  test("a ghost says nothing about how far the transcript has got", () => {
    // Typed in the turn's last 50ms: newer than the worker's final record, and the reply is still not there.
    assert.equal(transcriptBehindRest(rested(T(9)), [said(T(0)), restAt(T(1)), human(T(5)), { role: "user" as const, at: T(10), queued: true }]), true)
    assert.equal(transcriptBehindRest(rested(T(9)), [human(T(5)), said(T(9)), restAt(T(9)), { role: "user" as const, queued: true }]), false)
  })

  test("a running thread, or a rest with no instant, is never held", () => {
    assert.equal(transcriptBehindRest(rested(T(9), "running"), [human(T(5))]), false)
    assert.equal(transcriptBehindRest({ id: "t", runtime: "turn-idle" } as unknown as ThreadView, [human(T(5))]), false)
    assert.equal(transcriptBehindRest(undefined, []), false)
  })

  // ── …and the turn the transcript has not reached, at the turn's opening ──
  // A turn started from outside this tab: the board's `running` leads the push carrying the message that
  // opened it by 40-60ms; until that message lands the transcript still ends on the last rest.
  const live = (runtime: ThreadView["runtime"] = "running") => ({ id: "t", runtime } as unknown as ThreadView)
  const wakeBubble = { role: "user" as const, at: T(10), wake: true }
  const wakeDivider = { role: "assistant" as const, kind: "event" as const, boundary: "wake" as const, at: T(10) }

  test("a turn whose opening message the transcript does not carry yet is ahead of it", () => {
    assert.equal(transcriptBehindTurn(live(), [human(T(5)), said(T(8)), restAt(T(8))]), true)
    assert.equal(transcriptBehindTurn(live("spawning"), [human(T(5)), said(T(8)), restAt(T(8))]), true)
  })

  test("whatever opened the turn releases it — a human's bubble, a wake's bubble or its divider", () => {
    for (const opener of [human(T(10)), wakeBubble, wakeDivider]) {
      assert.equal(transcriptBehindTurn(live(), [human(T(5)), said(T(8)), restAt(T(8)), opener]), false, JSON.stringify(opener))
    }
    // The first record of the turn itself, should the opener never project (a dropped relay).
    assert.equal(transcriptBehindTurn(live(), [human(T(5)), said(T(8)), restAt(T(8)), said(T(11))]), false)
  })

  test("a send from this tab is never held: its ghost already sits after the rest", () => {
    const ghost = { role: "user" as const, at: T(10), queued: true }
    assert.equal(transcriptBehindTurn(live(), [human(T(5)), said(T(8)), restAt(T(8)), ghost]), false)
  })

  test("a rest, or a turn with nothing behind it, is never held as a turn", () => {
    assert.equal(transcriptBehindTurn(rested(T(9)), [human(T(5)), said(T(8)), restAt(T(8))]), false)
    assert.equal(transcriptBehindTurn(live(), [human(T(5))]), false)
    assert.equal(transcriptBehindTurn(live(), []), false)
    assert.equal(transcriptBehindTurn(undefined, [restAt(T(8))]), false)
  })

  // ── …and the next turn the transcript has already opened, past a rest the board still reports ──
  // A steer that waited out a turn is handed over the instant it ends; the transcript push carries it
  // ~20ms after the board's rest, and the board says running one tick later.
  test("a message landed after the rest boundary has opened the next turn", () => {
    assert.equal(transcriptPastRest(rested(T(9)), [human(T(5)), said(T(9)), restAt(T(9)), human(T(10))]), true)
    assert.equal(transcriptPastRest(rested(T(9), "exited"), [human(T(5)), said(T(9)), restAt(T(9)), wakeBubble]), true)
    assert.equal(transcriptPastRest(rested(T(9)), [human(T(5)), said(T(9)), restAt(T(9)), wakeDivider]), true)
  })

  test("a ghost, or a send nobody was handed, has not opened anything", () => {
    for (const m of [{ role: "user" as const, at: T(10), queued: true }, ...(["failed", "unconfirmed", "held"] as const).map((deliveryState) => ({ role: "user" as const, at: T(10), deliveryState }))]) {
      assert.equal(transcriptPastRest(rested(T(9)), [human(T(5)), said(T(9)), restAt(T(9)), m]), false, JSON.stringify(m))
    }
  })

  test("a rest with nothing after it, a turn the board already reports, or a message the rest came after is not past it", () => {
    assert.equal(transcriptPastRest(rested(T(9)), [human(T(5)), said(T(9)), restAt(T(9))]), false)
    assert.equal(transcriptPastRest(live(), [human(T(5)), said(T(9)), restAt(T(9)), human(T(10))]), false)
    // The human message the turn answered, with the turn's own rest after it.
    assert.equal(transcriptPastRest(rested(T(9)), [restAt(T(1)), human(T(5)), said(T(9)), restAt(T(9))]), false)
    // A message with no rest above it at all (the first turn) belongs to a turn the board already ended.
    assert.equal(transcriptPastRest(rested(T(9)), [human(T(5)), said(T(9))]), false)
    // …nor one a reply already answered, where the projection drew no boundary for that rest.
    assert.equal(transcriptPastRest(rested(T(9)), [restAt(T(1)), human(T(5)), said(T(9))]), false)
    assert.equal(transcriptPastRest(undefined, []), false)
  })

  // ── which side of the edge stays on screen: both ends of a turn, both orders of the two channels ──
  const turnOver = [human(T(5)), said(T(9)), restAt(T(9))]
  const showedTurn = { running: true }
  const showedRest = { running: false, restedId: "t", pastRest: false }

  test("turn end, board first: the turn stays up until the reply lands", () => {
    const behind = [said(T(0)), restAt(T(1)), human(T(5))]
    assert.deepEqual(transcriptHold(rested(T(9)), behind, showedTurn), { present: "turn", key: `rest:${T(9)}` })
    // A thread opened at rest over an older cached transcript was never showing the turn.
    assert.equal(transcriptHold(rested(T(9)), behind, showedRest), undefined)
  })

  test("turn end, transcript first and already into the next turn: the turn stays up", () => {
    assert.deepEqual(transcriptHold(rested(T(9)), [...turnOver, human(T(10))], showedTurn), { present: "turn", key: `next:${T(10)}` })
  })

  test("turn start, board first: the rest stays up until the opening message lands", () => {
    assert.deepEqual(transcriptHold(live(), turnOver, showedRest), { present: "rest", key: `turn:${T(9)}` })
    // Already showing a turn, or showing another thread's rest: nothing of this thread's to keep.
    assert.equal(transcriptHold(live(), turnOver, showedTurn), undefined)
    assert.equal(transcriptHold(live(), turnOver, { ...showedRest, restedId: "other" }), undefined)
    // …and once the message is there the board's turn is drawn.
    assert.equal(transcriptHold(live(), [...turnOver, human(T(10))], showedRest), undefined)
  })

  test("turn start, transcript first: the turn is drawn with the message the view saw arrive", () => {
    assert.deepEqual(transcriptHold(rested(T(9)), [...turnOver, human(T(10))], showedRest), { present: "turn", key: `next:${T(10)}` })
    assert.deepEqual(transcriptHold(rested(T(9)), [...turnOver, wakeDivider], showedRest), { present: "turn", key: `next:${T(10)}` })
    // A thread OPENED on a transcript that already ends in an unanswered message saw nothing arrive: the
    // first commit had no transcript at all, or the transcript was already past the rest.
    assert.equal(transcriptHold(rested(T(9)), [...turnOver, human(T(10))], { running: false, restedId: "t" }), undefined)
    assert.equal(transcriptHold(rested(T(9)), [...turnOver, human(T(10))], { running: false, restedId: "t", pastRest: true }), undefined)
  })

  test("channels that agree hold nothing", () => {
    assert.equal(transcriptHold(rested(T(9)), turnOver, showedTurn), undefined)
    assert.equal(transcriptHold(live(), [...turnOver, human(T(10))], showedTurn), undefined)
    assert.equal(transcriptHold(undefined, [], showedRest), undefined)
  })
}
