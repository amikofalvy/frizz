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
const steering = proxy({ at: {} as Record<string, number>, answered: {} as Record<string, string[]> })

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
    delete steering.answered[slug]
  }, STEER_OPTIMISM_MS))
}

// THE STEER ANSWERED THESE REGISTERED QUESTIONS — the ids ride beside the stamp, and the overlay takes
// them off the thread's open `questions`. Without them the row went to the Running band still holding the
// question it had just been given the answer to, and a running thread with an open question draws a "?"
// inside its spinner (groups.workingWithOpenQuestion: "a question is waiting on your answer"). So every
// answer sent from a queue card flashed that mark on its row until the server's board push dropped the
// question, 100-400ms later (painted frames, 2026-10-13). Ids accumulate for the life of the stamp: an
// answered question never reopens, so a stale id filters nothing.
export function markAnswered(slug: string, questionIds: readonly string[]): void {
  if (questionIds.length === 0) return
  steering.answered[slug] = [...new Set([...(steering.answered[slug] ?? []), ...questionIds])]
}

/** The standing stamp, read outside React; undefined once it has lapsed or been cleared. */
export function steeredAtNow(slug: string): number | undefined {
  return steering.at[slug]
}

/** The question ids the standing steer answered, read outside React. They live and die with the stamp:
 *  its expiry and clearSteered drop both. */
export function answeredNow(slug: string): readonly string[] | undefined {
  return steering.answered[slug]
}

// The send failed and its bubble was rolled back — the thread is not working after all.
export function clearSteered(slug: string): void {
  const prior = expiries.get(slug)
  if (prior !== undefined) { clearTimeout(prior); expiries.delete(slug) }
  delete steering.at[slug]
  delete steering.answered[slug]
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
export function optimisticallySteered(t: ThreadView, at: number | undefined, nowMs = Date.now(), answered?: readonly string[]): ThreadView {
  const local = at !== undefined && isOptimisticallySteering(t, at, nowMs)
  if (!local && t.deliveryInFlight !== true) return t
  return steeredFields(t, local ? new Date(at!).toISOString() : t.lastUserAt, local ? answered : undefined)
}

function steeredFields(t: ThreadView, lastUserAt: string | undefined, answered?: readonly string[]): ThreadView {
  return {
    ...t,
    runtime: "running",
    // The registered questions this steer answered are no longer open (markAnswered). The board's own
    // array when it answered none, so nothing keyed on it churns.
    questions: answered?.length && t.questions?.some((q) => answered.includes(q.id)) ? t.questions.filter((q) => !answered.includes(q.id)) : t.questions,
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
export type SteerEvidence = Pick<TranscriptMessage, "role" | "kind" | "boundary" | "queued" | "deliveryState" | "at" | "wake" | "peerFrom" | "agentInstruction" | "sessionPeer">

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
  // A rest the transcript has not reached is not one a send can have ended: the ghost after `restIndex`
  // there is a steer that waited out the turn whose end the board has just reported, and for the ~20ms
  // until the reply lands the turn on screen is still that turn (useTurnHeldForTranscript keeps it). Read
  // as "a send ended the rest", it re-based the Working clock on the steer's own instant for one frame:
  // `5s`, `3s`, then `0s` when the reply landed (measured 2026-10-13, 12 of 12 text-turn steers).
  if (transcriptBehindRest(t, messages)) return t
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

export type RestEvidence = Pick<TranscriptMessage, "role" | "kind" | "boundary" | "at" | "queued">

export function transcriptBehindRest(t: ThreadView | undefined, messages: readonly RestEvidence[]): boolean {
  if (!t || (t.runtime !== "turn-idle" && t.runtime !== "exited")) return false
  const said = Date.parse(t.lastAssistantAt ?? "")
  if (!Number.isFinite(said)) return false
  // Asked of what has LANDED. A ghost carries the instant it was typed, or none, and says nothing about how
  // far the transcript has got: one typed in a turn's last 50ms is newer than that turn's final record.
  for (const m of messages) if (!m.queued && Date.parse(m.at ?? "") >= said) return false
  // A rest boundary is THIS rest only when nothing has landed after it. A turn the human opened finds its
  // opening message first, and stops there. But a turn a sub-agent's or a shell's completion opened has no
  // human message: its opener is the completion's own row, and walking back past it found the PREVIOUS
  // rest's boundary and took the transcript for caught up. The Working row then went on the board's word
  // and the reply landed 20ms later, a second state (a sub-agent waking its resting worker: 3 of 3,
  // 2026-10-14).
  let landedAfter = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.queued) continue
    if (m.kind === "event" && m.boundary === "rest") return landedAfter
    if (m.role === "user") break
    landedAfter = true
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

// …and the same race the other way round at a turn's END, when the next turn is already waiting: a steer
// that waited out a turn with no tool call is handed over the instant that turn ends, so the worker's
// `result` and the next turn's opening record reach the server a few ms apart. The board's tick reads the
// file before the opening record is on disk and reports the rest; the transcript push reads it ~20ms
// later and already carries the delivered steer; the board says `running` again one tick after that. For
// those 40-60ms the view dropped its Working row under a steer the worker had already been handed, then
// drew it back (measured 2026-10-13 on scripted broker workers: 10 of 12 two-steer recordings). The
// transcript is right: a message that LANDED after the turn's rest boundary has opened the next turn, so
// while the board catches up the view keeps the turn it was showing. Queued ghosts are steeredSinceRest's,
// and a failed, unconfirmed or held send has not been handed to anyone, so none of those counts.
//
// The same evidence opens a turn FROM A REST, when the transcript gets there first: this tab's own
// `threadTranscript` refetch (the one ~1.5s after a rest) can land between the JSONL write of another
// tab's message and the board delta, and then the view drew the hairline and the bubble with no Working
// row for a frame or two before Working arrived and pushed the tail 37px (lv-turns' recordings,
// 2026-10-13: `rpc< threadTranscript` +32ms, bubble without Working +49ms, Working +72ms). A wake's
// divider counts as an opener there too.
export function transcriptPastRest(t: ThreadView | undefined, messages: readonly HoldEvidence[]): boolean {
  if (!t || (t.runtime !== "turn-idle" && t.runtime !== "exited")) return false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === "event" && m.boundary === "rest") return false
    // A reply after the message means the rest the board reports is that message's own turn ending.
    if (m.role === "assistant" && m.kind !== "event") return false
    const woke = m.kind === "event" && m.boundary === "wake"
    if (!woke && (m.role !== "user" || m.queued)) continue
    if (m.deliveryState === "failed" || m.deliveryState === "unconfirmed" || m.deliveryState === "held") continue
    // A landed message: it opened a turn only if the turn before it had ended — a rest boundary above it.
    for (let j = i - 1; j >= 0; j--) {
      const above = messages[j]
      if (above.kind === "event" && above.boundary === "rest") return true
      if (above.role === "assistant" && above.kind !== "event") return false
    }
    return false
  }
  return false
}

type HoldEvidence = RestEvidence & Pick<TranscriptMessage, "deliveryState">

/** What the view's LAST COMMIT showed for this thread: which side of the turn's edge was on screen, and
 *  whether its transcript had already moved past the rest. */
export interface HoldPrior {
  running: boolean
  /** The thread the last commit presented at rest, if it did. */
  restedId?: string
  /** transcriptPastRest at the last commit; undefined while no transcript was loaded. */
  pastRest?: boolean
}

/** WHICH SIDE OF A TURN'S EDGE TO KEEP ON SCREEN while the board and the transcript disagree about it. The
 *  two channels report the same edge in either order, at either end of a turn, so there are four cases and
 *  each holds only when the view was showing the side being kept:
 *  · turn END, board first (transcriptBehindRest): the view showed the turn → keep the turn;
 *  · turn END, transcript first and already into the next turn (transcriptPastRest): showed the turn → keep it;
 *  · turn START, board first (transcriptBehindTurn): the view showed this thread's rest → keep that rest;
 *  · turn START, transcript first (transcriptPastRest again): the view showed this thread's rest and SAW the
 *    opening message arrive → present the turn now, since the board is about to. A thread OPENED on a
 *    transcript that already ends in an unanswered message (a worker that died on it) saw nothing arrive
 *    and reads as the board says.
 *  `key` names the episode, for the cap. */
export function transcriptHold(t: ThreadView | undefined, messages: readonly HoldEvidence[], prior: HoldPrior): { present: "turn" | "rest"; key: string } | undefined {
  if (transcriptBehindRest(t, messages)) return prior.running ? { present: "turn", key: `rest:${t!.lastAssistantAt}` } : undefined
  const last = messages[messages.length - 1]
  if (transcriptBehindTurn(t, messages)) {
    return !prior.running && prior.restedId === t!.id ? { present: "rest", key: `turn:${last!.at ?? ""}` } : undefined
  }
  if (transcriptPastRest(t, messages)) {
    const sawItArrive = prior.restedId === t!.id && prior.pastRest === false
    return prior.running || sawItArrive ? { present: "turn", key: `next:${last!.at ?? ""}` } : undefined
  }
  return undefined
}

/** The thread as the thread view should present it: the board's, unless transcriptHold says the other
 *  side of a turn's edge stays on screen until the lagging channel catches up — for at most
 *  REST_CATCH_UP_MS, so a channel that never catches up cannot pin the view. ONE hook for both ends and
 *  both orders, so there is one place that reconciles the two channels. A held rest is the thread exactly
 *  as it was last presented, so the resting card and the reply slot do not change either. Returned by
 *  identity whenever nothing is held. */
export function useTurnHeldForTranscript(t: ThreadView | undefined, messages: readonly HoldEvidence[]): ThreadView | undefined {
  // What the LAST COMMIT presented: read during render, written after commit, so the first render that
  // finds the channels disagreeing asks what the frame on screen was showing.
  const prior = useRef<HoldPrior>({ running: false })
  const shownRested = useRef<ThreadView | undefined>(undefined)
  const [expired, setExpired] = useState<string | undefined>(undefined)
  const hold = transcriptHold(t, messages, prior.current)
  // Each held episode has its own key, so its expiry never cancels a later one.
  const key = hold?.key
  useEffect(() => {
    if (key === undefined) return
    const timer = setTimeout(() => setExpired(key), REST_CATCH_UP_MS)
    return () => clearTimeout(timer)
  }, [key])
  let presented = t
  if (hold && expired !== hold.key) presented = hold.present === "turn" ? steeredFields(t!, t!.lastUserAt) : shownRested.current ?? t
  const running = presented?.runtime === "running" || presented?.runtime === "spawning"
  const pastRest = messages.length > 0 ? transcriptPastRest(t, messages) : undefined
  useEffect(() => {
    prior.current = { running, restedId: running ? undefined : presented?.id, pastRest }
    shownRested.current = running ? undefined : presented
  }, [running, presented, pastRest])
  return presented
}

// Apply the overlay across a board's threads. A thread with no live steer is returned BY IDENTITY, so
// the memoized rows still skip re-rendering; the memo re-runs when the board changes or when a stamp
// is set/expired (markSteered's expiry timer is what guarantees the cap actually repaints).
export function useOptimisticallySteered(threads: readonly ThreadView[]): ThreadView[] {
  const { at, answered } = useSnapshot(steering) as { at: Record<string, number>; answered: Record<string, readonly string[]> }
  return useMemo(() => threads.map((t) => optimisticallySteered(t, at[t.id], undefined, answered[t.id])), [threads, at, answered])
}
