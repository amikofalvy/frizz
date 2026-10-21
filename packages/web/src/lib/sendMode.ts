import { useEffect, useRef } from "react"
import { proxy, useSnapshot } from "valtio"

// HOW THE PROMPT BOX'S SEND GOES OUT while the agent is working (maintainer 2026-10-11). The button
// always reads "Send"; its caret menu ticks one of three rows:
//
//   steer         — the message is handed to the agent now and read at its next step. The default, and
//                   what every send was before the menu existed.
//   queue         — Frizz keeps the message until the agent comes to rest, then delivers it as the next
//                   turn. Everything queued this way goes out together.
//   one-at-a-time — the same hold, but each message gets a turn of its own: Frizz hands over the next
//                   one only when the agent has rested after the one before (FollowUpInput.ownTurn,
//                   added 2026-10-20).
//
// One more way, the FORCED send that interrupts the turn, is deliberately not a row: it stays on
// ⌘/Ctrl-Enter and on the Send now under the queued messages.
//
// PER THREAD, IN MEMORY, AND BACK TO STEER WHEN THE AGENT RESTS. Queueing is a decision about the turn
// in front of the operator — "not now, after this" — so it ends with that turn: a tick that outlived it
// would silently hold the first message of some later turn, which nobody asked for. Module scope
// because one thread is steerable from several mounted prompt boxes at once (the queue card and the
// drawer), and they must agree.
//
// One at a time spans several turns by design — its queue drains one rest at a time — so its "turn in
// front of the operator" ends only when the agent rests with nothing held and nothing on its way. Reset
// at the first rest, the tick would make the next message typed between two queued ones a steer into
// the turn answering the first.
export type SendMode = "steer" | "queue" | "one-at-a-time"

/** Is this a way of sending that HOLDS the message for the agent's rest? */
export function holdsForRest(mode: SendMode): boolean {
  return mode !== "steer"
}

const modes = proxy({ of: {} as Record<string, SendMode> })

export function setSendMode(slug: string, mode: SendMode): void {
  if (mode === "steer") delete modes.of[slug]
  else modes.of[slug] = mode
}

/** The ticked row for this thread. `running` is "a turn is in flight" — the edge back to rest is what
 *  resets the tick. `queued` is "something this thread queued is held or on its way", which one at a
 *  time waits out as well. */
export function useSendMode(slug: string, running: boolean, queued = false): SendMode {
  const mode = useSnapshot(modes).of[slug] ?? "steer"
  const busy = running || (mode === "one-at-a-time" && queued)
  const was = useRef(busy)
  useEffect(() => {
    if (was.current && !busy) setSendMode(slug, "steer")
    was.current = busy
  }, [busy, slug])
  return mode
}

/** What the placeholder says an empty prompt box is for. A staged answer outranks everything: the box
 *  is then a note on the answers, whichever way they go. An open question with nothing staged makes
 *  the box the way AROUND it. Otherwise it names how the ticked row will send, which only differs from
 *  an ordinary reply while there is a turn to queue behind. */
export function sendPlaceholder(input: { staged: number; openQuestions: boolean; running: boolean; mode: SendMode }): string {
  if (input.staged > 0) return input.staged === 1 ? "Add a note to send with your answer…" : `Add a note to send with your ${input.staged} answers…`
  if (input.openQuestions) return "Or skip the questions and reply…"
  if (input.running && input.mode === "queue") return "Queue a message for when the agent rests…"
  if (input.running && input.mode === "one-at-a-time") return "Queue a message for a turn of its own…"
  return "Reply to the agent…"
}
