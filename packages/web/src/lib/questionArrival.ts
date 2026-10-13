// A FENCE-ASKED QUESTION WAITS FOR ITS MESSAGE — so its card is first drawn where it belongs.
//
// A question a worker asks with a ```question fence becomes a row on the board, and the fence's message
// reaches the transcript. Both come from one poll of the server's tailer, on two channels: the board is
// pushed, the transcript is refetched over an RPC. The push wins by a round trip — 20-30ms on all eight
// runs measured on a real stack (2026-10-13) — and in that beat the surface held an open question with no
// message naming it. A question nothing names renders at its anchor, the tail: the live card was drawn at
// the bottom of the transcript under the PREVIOUS message, and a frame or two later hopped up into the
// prose of the message that asked it.
//
// So a row is held back until the transcript has caught up with it. Its fence WILL arrive, in a message
// stamped at or before the row's `askedAt` (the instant of the record that carried the fence), and the
// transcript has caught up when either is true:
//
// - some loaded message is stamped at or after `askedAt` — the "Agent rested" line counts; or
// - a loaded message names the row with a fence. A fence in a message's SECOND record is asked later
//   than the bubble is stamped, and mid-turn nothing later may exist yet.
//
// ONLY A ROW WITH A HANDLE WAITS. A question the `ask` RPC registered has no fence coming: nothing will
// ever name it, and it draws at the tail at once, as it always has.
//
// THE WAIT IS BOUNDED AT 2s, counted from when this tab first saw the row. The gap being covered is one
// local RPC round trip, so two seconds is roughly a hundred times the usual and still inside the "second
// or two" the pending card was already designed around (the registrar itself runs a poll behind the
// worker). Past it something else is wrong — the transcript channel is down and polling, the message was
// folded out of the window — and an answerable question the human cannot see is worse than a card that
// starts at the tail, which is exactly what the surface did before this rule.
import type { AskedQuestion } from "@frizz/shared"
import { questionFenceBlocks } from "@frizz/shared"
import { questionNames } from "./questionShadow.ts"

export const FENCE_MESSAGE_WAIT_MS = 2000

export interface ArrivalMessage {
  role: string
  at?: string
  text?: string
}

export interface ArrivingQuestion {
  id: string
  askedAt: string
  spec: AskedQuestion
}

/** Is this fence-asked row still ahead of the loaded transcript — no message at or after its instant, and
 *  none naming it? Never true for a row without a handle, or one whose instant cannot be read. */
export function awaitsItsMessage(q: ArrivingQuestion, messages: readonly ArrivalMessage[]): boolean {
  if (!q.spec.handle) return false
  const asked = Date.parse(q.askedAt)
  if (!Number.isFinite(asked)) return false
  // Newest first: the message that settles it is at the tail.
  let names: string[] | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const at = m.at ? Date.parse(m.at) : Number.NaN
    if (Number.isFinite(at) && at >= asked) return false
    if (m.role === "assistant" && m.text?.includes("```question")) {
      names ??= questionNames(q)
      for (const b of questionFenceBlocks(m.text)) {
        if (b.read.form !== "invalid" && names.includes(b.read.id.toLowerCase())) return false
      }
    }
    // Stamped before the ask and not naming it: everything above is older still.
    if (Number.isFinite(at)) break
  }
  return true
}

/** The questions a surface draws now: every open row except a fence-asked one still waiting for its
 *  message inside the bound. `firstSeen` is the surface's own memory of when each waiting row was first
 *  seen (mutated here: a row is added when it starts waiting and dropped when it stops). `wakeAt` is when
 *  the earliest wait runs out, for the caller to re-ask at. The input array itself comes back when nothing
 *  is held, which is nearly always. */
export function arrivedQuestions<Q extends ArrivingQuestion>(
  open: readonly Q[],
  messages: readonly ArrivalMessage[],
  firstSeen: Map<string, number>,
  nowMs: number,
): { shown: readonly Q[]; wakeAt?: number } {
  let wakeAt: number | undefined
  const held = new Set<string>()
  for (const q of open) {
    if (!awaitsItsMessage(q, messages)) {
      firstSeen.delete(q.id)
      continue
    }
    const since = firstSeen.get(q.id) ?? nowMs
    firstSeen.set(q.id, since)
    const until = since + FENCE_MESSAGE_WAIT_MS
    if (nowMs >= until) continue
    held.add(q.id)
    wakeAt = wakeAt === undefined ? until : Math.min(wakeAt, until)
  }
  if (firstSeen.size > held.size) {
    const live = new Set(open.map((q) => q.id))
    for (const id of firstSeen.keys()) if (!live.has(id)) firstSeen.delete(id)
  }
  return held.size === 0 ? { shown: open } : { shown: open.filter((q) => !held.has(q.id)), wakeAt }
}
