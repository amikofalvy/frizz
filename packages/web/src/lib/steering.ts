import { useEffect, useMemo, useRef, useState } from "react"
import { proxy, useSnapshot } from "valtio"
import type { ThreadView, TranscriptMessage } from "@frizz/shared"

// OPTIMISTIC STEER STATE — "your message is in, this thread is working again", rendered the instant
// the operator commits rather than when the server can prove it.
//
// Why this needs to exist at all: delivering a follow-up is a synchronous injection that takes
// ~250–800ms of subprocess work, and the thread only reads as RUNNING once the tailer subsequently
// observes the worker's turn start in the JSONL — seconds later, on a poll frizz does not control. In
// between, every board-driven surface still renders the thread exactly as it was: at rest, or worse,
// still wearing its "needs your input" mark for an ask the human just answered. The steer looks lost.
//
// The optimistic record closes that window. It is NOT a second source of truth: it is a short-lived
// hint that only ever fires while server truth has said nothing new, and it yields the moment the
// server has anything at all to say.
const steering = proxy({ at: {} as Record<string, number> })

// How long the hint may outlive its evidence. Past this the operator is better served by the truth —
// a steer that produced no observable activity in twelve seconds is one they should see stalled,
// not one we keep pretending is fine.
export const STEER_OPTIMISM_MS = 12_000

const expiries = new Map<string, ReturnType<typeof setTimeout>>()

export function markSteered(slug: string, nowMs = Date.now()): void {
  steering.at[slug] = nowMs
  const prior = expiries.get(slug)
  if (prior !== undefined) clearTimeout(prior)
  // The hint's own expiry must REPAINT, not just elapse: nothing else is guaranteed to re-render a
  // quiet thread at the cap, so without this the spinner could outlive its window on screen.
  expiries.set(slug, setTimeout(() => {
    expiries.delete(slug)
    delete steering.at[slug]
  }, STEER_OPTIMISM_MS))
}

// The send failed and its bubble was rolled back — the thread is not working after all.
export function clearSteered(slug: string): void {
  const prior = expiries.get(slug)
  if (prior !== undefined) { clearTimeout(prior); expiries.delete(slug) }
  delete steering.at[slug]
}

// Whether `t` should render as working purely on the strength of a just-sent steer. Server truth wins
// the instant it exists: any board activity stamped after the steer means the tailer has looked at
// this thread since, so whatever it now reports — running, or already finished and back at rest — is
// better than our guess.
export function isOptimisticallySteering(t: ThreadView, at: number | undefined, nowMs = Date.now()): boolean {
  if (at === undefined || nowMs - at > STEER_OPTIMISM_MS) return false
  const activity = t.lastActivityAt ? Date.parse(t.lastActivityAt) : NaN
  return !(Number.isFinite(activity) && activity > at)
}

// React binding. Returns the raw stamp map so a row can ask about its own slug without subscribing
// every row to every other row's steers.
export function useSteeredAt(): Record<string, number> {
  return useSnapshot(steering).at as Record<string, number>
}

// THE overlay: the board fields a just-sent steer asserts on the operator's behalf. Deliberately a
// whole ThreadView rather than a "show a spinner" flag, because the rail's PLACEMENT is derived — the
// section, the running/rested band, the order within it — and a hint only the indicator consults
// produces exactly the split the operator sees today: the row spins instantly while sitting among the
// queue cards for seconds, then hops. Overlaying the fields instead lets every existing pure predicate
// (isActivelyRunning, isSnoozed, sectionOf, orderActive, sessionIndicatorKind) reach the same conclusion
// from ONE rule.
//
// Every field here is what the SERVER itself will report once the tailer sees the turn start, so the
// optimistic position is the position truth lands on — the row settles once and never hops again.
//
// THE SERVER CAN ASSERT THE SAME THING, and does once it has stored the message (`deliveryInFlight`,
// board.deriveDeliveryInFlight). The local stamp is instant but lives 12s in the one tab that sent it; the
// server's flag reaches every tab and a reload, and holds for as long as the delivery is actually on its
// way. Either one takes the overlay. Only the local stamp moves `lastUserAt`: it is the only one that
// knows the instant, and the server's own reading of it lands with the turn.
export function optimisticallySteered(t: ThreadView, at: number | undefined, nowMs = Date.now()): ThreadView {
  const local = at !== undefined && isOptimisticallySteering(t, at, nowMs)
  if (!local && t.deliveryInFlight !== true) return t
  return steeredFields(t, local ? new Date(at!).toISOString() : t.lastUserAt)
}

function steeredFields(t: ThreadView, lastUserAt: string | undefined): ThreadView {
  return {
    ...t,
    runtime: "running",
    // A running thread is not awaiting you — deriveNeedsYou says so itself (`if (!atRest) return
    // false`). The queue reasons a steer resolves (an unanswered question, a native ask, a permission
    // prompt, a bare-rest handoff) are precisely the ones the operator just cleared by typing; the
    // queue card already leaves on that assumption, and the rail row must agree with it.
    needsYou: false,
    pendingAsk: undefined,
    pendingQuestion: false,
    actionableInteraction: false,
    // The steer IS a user interaction, and the running band orders by user recency (groups.ts
    // orderByInteraction). Without this the row would enter the band at its STALE position and then
    // jump again when the server reported this same instant a beat later.
    lastUserAt,
    // lastActivityAt is deliberately untouched: it is the evidence isOptimisticallySteering watches
    // for to hand the row back to server truth, so writing it here would make the hint self-sealing.
  }
}

// What steeredSinceRest reads off a transcript message.
export type SteerEvidence = Pick<TranscriptMessage, "role" | "queued" | "deliveryState" | "at" | "wake" | "peerFrom" | "agentInstruction" | "sessionPeer">

// THE THREAD VIEW'S READING OF THE SAME STEER, keyed to the transcript it draws rather than to the stamp.
//
// The thread view read the raw board until 2026-10-13, so a send drew its ghost bubble at once while the
// rest's awaiting or sign-off card stayed beside it for the seconds the tailer took to see the turn start
// (maintainer: "That should happen in the same render"). The rail's overlay above is not the answer
// there: the stamp says nothing about what the transcript shows, so keyed on it the card could go before
// the bubble came. So the rest ends on the HUMAN'S TURN: a send of theirs sits after the rest's last
// assistant message (`restIndex`) and is still on its way —
//   · it is drawn as a ghost (a queued bubble — the optimistic copy, or the server's projection of it):
//     the same cache write that draws the bubble ends the rest, so the two land in one render; or
//   · it has landed and the steer behind it is still live (the stamp, or the server's deliveryInFlight),
//     which covers the beat between the echo and the board's "running".
// Only a REST ends this way. A thread the board has mid-turn is returned untouched, so a permission
// prompt or an open interaction card is never overlaid with a Working line. A failed or unconfirmed send
// is not on its way, and a held one is the server's to release at the rest, so none of those counts.
// Returned by identity when nothing applies, so memos keyed on the thread hold.
export function steeredSinceRest(
  t: ThreadView | undefined,
  messages: readonly SteerEvidence[],
  restIndex: number,
  at: number | undefined,
  nowMs = Date.now(),
): ThreadView | undefined {
  if (!t || (t.runtime !== "turn-idle" && t.runtime !== "exited")) return t
  let human = false
  let ghost = false
  let ghostAt: string | undefined
  for (let i = restIndex + 1; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== "user" || m.wake || m.peerFrom || m.agentInstruction || m.sessionPeer) continue
    if (m.deliveryState === "failed" || m.deliveryState === "unconfirmed" || m.deliveryState === "held") continue
    human = true
    if (m.queued) {
      ghost = true
      ghostAt = m.at ?? ghostAt
    }
  }
  if (!human) return t
  const local = at !== undefined && isOptimisticallySteering(t, at, nowMs)
  if (!ghost && !local && t.deliveryInFlight !== true) return t
  // The instant this stretch of work began, for the Working line's clock: the send itself when this tab
  // made it, else the server's projected bubble. The board's own lastUserAt names the PREVIOUS turn here.
  return steeredFields(t, local ? new Date(at!).toISOString() : ghostAt ?? t.lastUserAt)
}

// THE REST THE TRANSCRIPT HAS NOT REACHED YET — steeredSinceRest's mirror, at the other end of the turn.
//
// One tailer tick sees a worker's last record and the end of its turn together, and the server reports
// them on two channels in a fixed order: the board delta saying `turn-idle` goes out synchronously from
// that tick, and the transcript push carrying the record follows a microtask and a ~20ms projection read
// later (tailer.ts calls onChange before onTranscriptChange; app-socket.ts flushTranscriptChanges). The
// client widens the gap: a board write paints in a microtask, a transcript write on TanStack Query's
// setTimeout(0). So the thread view painted a frame with the Working row gone and the reply not yet
// there — the transcript shrank by the row and then grew by the reply (measured on real Haiku workers,
// 2026-10-13: the board led by 17-23ms on every turn end, and a frame landed in the gap every time).
//
// So while the board reports a rest the transcript has not reached, the view keeps presenting the turn
// it was already showing, and the reply and the rest land in one render. "Not reached": the board's
// lastAssistantAt (the worker's own last record) is newer than anything in the transcript, AND the
// transcript has no rest boundary after the turn's opening message — the boundary is the projection's own
// word that the turn ended (transcript.ts restMessage), so a transcript carrying it has caught up even
// where the instants disagree. Only a turn this view was already drawing is held, so a thread opened at
// rest over an older cached transcript reads as rested as it always has; and never for longer than
// REST_CATCH_UP_MS, so a transcript that never catches up cannot keep a rested thread spinning.
export const REST_CATCH_UP_MS = 1_500

export type RestEvidence = Pick<TranscriptMessage, "role" | "kind" | "boundary" | "at">

export function transcriptBehindRest(t: ThreadView | undefined, messages: readonly RestEvidence[]): boolean {
  if (!t || (t.runtime !== "turn-idle" && t.runtime !== "exited")) return false
  const said = Date.parse(t.lastAssistantAt ?? "")
  if (!Number.isFinite(said)) return false
  for (const m of messages) if (Date.parse(m.at ?? "") >= said) return false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === "event" && m.boundary === "rest") return false
    if (m.role === "user") break
  }
  return true
}

// THE TURN THE TRANSCRIPT HAS NOT REACHED YET — the same race at the turn's OPENING, when the turn was
// started from outside this tab: another tab's or device's send, `frizzctl steer`, a scheduler wake, a
// background shell finishing. The board delta saying `running` again goes out ahead of the transcript push
// carrying the message that opened the turn, by 40-60ms (measured 2026-10-13 on scripted broker workers,
// 12 of 12 runs), and for those frames the view drew its Working row straight under the rest card, with a
// clock counting from the PREVIOUS turn's opening ("Thinking… 58s"), before the opening message and its
// rest divider landed above it and pushed it down 97px.
//
// "Not reached": the board reports a turn and the transcript still ENDS on the last turn's rest boundary —
// nothing at all after it. Whatever opened the turn lands after that boundary when it lands, a human's
// bubble, a wake's bubble or divider, a peer's message, so its arrival is what releases the hold, whatever
// kind it is. A send from THIS tab never matches: its ghost bubble already sits after the rest in the same
// render that sent it (lib/restReply.ts, steeredSinceRest), so the transcript does not end on the rest.
export function transcriptBehindTurn(t: ThreadView | undefined, messages: readonly RestEvidence[]): boolean {
  if (!t || (t.runtime !== "running" && t.runtime !== "spawning")) return false
  const last = messages[messages.length - 1]
  return last?.kind === "event" && last.boundary === "rest"
}

/** The thread as the thread view should present it: the board's, unless the board and the transcript
 *  disagree about where the turn is while the view was showing the other side of that edge —
 *  · a rest the transcript has not reached, while the view showed the turn: the turn (transcriptBehindRest);
 *  · a turn the transcript has not reached, while the view showed the rest: the rest exactly as it was last
 *    presented (transcriptBehindTurn), so the resting card and the reply slot do not change either.
 *  Either for at most REST_CATCH_UP_MS, so a transcript that never catches up cannot pin the view. ONE hook
 *  for both ends, so there is one place that reconciles the two channels' order. Returned by identity
 *  whenever nothing is held. */
export function useTurnHeldForTranscript(t: ThreadView | undefined, messages: readonly RestEvidence[]): ThreadView | undefined {
  const restAhead = transcriptBehindRest(t, messages)
  const turnAhead = !restAhead && transcriptBehindTurn(t, messages)
  // Each held episode has its own key, so its expiry never cancels a later one: the rest by the worker's
  // last record, the turn by the rest boundary it would be drawn under.
  const key = restAhead ? `rest:${t!.lastAssistantAt}` : turnAhead ? `turn:${messages[messages.length - 1]!.at ?? ""}` : undefined
  // What the LAST COMMIT presented: read during render, written after commit, so the first render that
  // finds the transcript behind asks whether the frame on screen was on the other side of the edge.
  const shownRunning = useRef(false)
  const shownRested = useRef<ThreadView | undefined>(undefined)
  const [expired, setExpired] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (key === undefined) return
    const timer = setTimeout(() => setExpired(key), REST_CATCH_UP_MS)
    return () => clearTimeout(timer)
  }, [key])
  const live = key !== undefined && expired !== key
  let presented = t
  if (live && restAhead && shownRunning.current) presented = steeredFields(t!, t!.lastUserAt)
  else if (live && turnAhead && !shownRunning.current && shownRested.current?.id === t!.id) presented = shownRested.current
  const running = presented?.runtime === "running" || presented?.runtime === "spawning"
  useEffect(() => {
    shownRunning.current = running
    shownRested.current = running ? undefined : presented
  }, [running, presented])
  return presented
}

// Apply the overlay across a board's threads. A thread with no live steer is returned BY IDENTITY, so
// the memoized rows still skip re-rendering; the memo re-runs when the board changes or when a stamp
// is set/expired (markSteered's expiry timer is what guarantees the cap actually repaints).
export function useOptimisticallySteered(threads: readonly ThreadView[]): ThreadView[] {
  const at = useSteeredAt()
  return useMemo(() => threads.map((t) => optimisticallySteered(t, at[t.id])), [threads, at])
}
