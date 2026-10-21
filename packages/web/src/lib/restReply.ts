import type { ChatMessage } from "../hooks.ts"

// THE SEND THAT ENDS A REST IS DRAWN WHERE IT IS GOING TO LAND.
//
// A queued bubble belongs in the queued tail, under the Working… row and after everything else, because a
// send typed into a RUNNING turn really does wait behind it and lands wherever the turn has got to by
// then. A send that answers a REST waits behind nothing: it is the message that starts the next turn, and
// the server's copy of it lands directly under the rest's "Agent rested" hairline, ABOVE the Working row.
// Drawn in the tail, its ghost committed one layout and the echo another one 40-800ms later: the bubble
// hopped from under "Thinking…" to above it, and the hairline (redundant while nothing but a queued bubble
// followed it) appeared over it, moving the Working row 100px and everything above it ~40px. Measured on
// real Haiku workers resting on a done card and on a steps card (2026-10-13), and it is the second jump in
// the maintainer's one-second recording of pressing Done.
//
// So the ghost of that ONE send takes the landed message's place from its first frame: an ordinary row in
// the message flow, under the hairline, carrying the instant it was sent so the hairline above it is dated
// (ChatView restGapOf) exactly as it will be above the landed copy. It still RENDERS as a ghost (`queued` stays set: half opacity, and
// whatever affordances a queued bubble offers); only its place changes, so the echo changes its opacity
// and nothing else.
//
// Keyed on the TRANSCRIPT, not the board, for the reason steeredSinceRest is (lib/steering.ts): the board
// reports the turn on its own clock, and a position that flipped with it would hop the bubble twice. The
// rest is the transcript's own rest boundary with nothing the agent said after it, and the send is the
// first message after that boundary. A wake, a peer's message or an instruction that got there first means
// the agent is no longer resting on the human, and a send after the first is queued behind the turn the
// first one started. A failed, unconfirmed or held send stays in the tail, as before.

type Evidence = Pick<ChatMessage, "role" | "kind" | "boundary" | "queued" | "deliveryState" | "wake" | "peerFrom" | "agentInstruction" | "sessionPeer">

/** The index of the queued send that answers the transcript's closing rest, or -1. */
export function restReplyIndex(messages: readonly Evidence[]): number {
  let rest = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "assistant") continue
    if (m.kind === "event" && m.boundary === "rest") rest = i
    break
  }
  const first = rest >= 0 ? messages[rest + 1] : undefined
  if (!first?.queued || first.role !== "user") return -1
  if (first.wake || first.peerFrom || first.agentInstruction || first.sessionPeer) return -1
  if (first.deliveryState === "failed" || first.deliveryState === "unconfirmed" || first.deliveryState === "held") return -1
  return rest + 1
}

/** The list with that send marked to draw inline, stamped with `sentAt` when it carries no instant of its
 *  own. Returned BY IDENTITY when there is no such send, so the memos downstream hold. */
export function withRestReplyInline(messages: ChatMessage[], sentAt: string | undefined): ChatMessage[] {
  const i = restReplyIndex(messages)
  if (i < 0) return messages
  const next = messages.slice()
  next[i] = { ...messages[i], restReply: true, at: messages[i].at ?? sentAt }
  return next
}

/** Drawn in the queued tail rather than the message flow. Every row builder, spacer and divider rule asks
 *  this rather than reading `queued`, so the inline send is laid out exactly as its landed copy will be. */
export function inQueuedTail(message: Pick<ChatMessage, "queued" | "restReply">): boolean {
  return message.queued === true && message.restReply !== true
}

/** THE QUEUED TAIL as the one Send now under it reads it (ChatView QueuedSendNow): how many of its
 *  messages Frizz is holding for the agent's rest, and how many are waiting on its next step. A failed or
 *  unconfirmed send is neither — it carries its own row, and nothing is waiting on it. */
export interface QueuedRun {
  held: number
  steered: number
}

export function queuedRunOf(messages: readonly Pick<ChatMessage, "queued" | "restReply" | "deliveryState">[]): QueuedRun {
  let held = 0
  let steered = 0
  for (const m of messages) {
    if (!inQueuedTail(m) || m.deliveryState === "failed" || m.deliveryState === "unconfirmed") continue
    if (m.deliveryState === "held") held++
    else steered++
  }
  return { held, steered }
}
