import type { TranscriptMessage } from "@frizz/shared"

// Rendering-only text choice. The server keeps a generated prompt's full `text` for transcript logic
// and supplies `displayText` only when an exact presentation boundary was validated.
export function messagePresentationText(message: Pick<TranscriptMessage, "text" | "displayText">): string {
  return message.displayText ?? message.text
}

// The CURRENT ASK: the most recent user turn the HUMAN is actually waiting on an answer to. It pins to
// the pane top (ChatView's StickyUserBand) and supplies the retry text after a provider fault, so "who
// wrote it" decides it — not the `user` role, which the transcript also uses for machine-written turns.
//
// Excluded: a QUEUED/optimistic follow-up (it pins to the bottom until it lands), a SUB-AGENT's
// upward report, and a SCHEDULER WAKE. `peerFrom` and `wake` are the server's own tells that a CHILD
// or FRIZZ ITSELF wrote the turn (the schema calls them one defect class), and neither is an ask or
// anything to retry. Without the `peerFrom` guard an orchestrator running a dozen children re-pins the
// band to "Sub-agent «…» reported" on every report, burying the human's actual instruction, and a
// fault retry would resend the child's words as the human's.
//
// `wake` is the same failure with a worse blast radius, because a wake does not render as a BUBBLE.
// UserBubble collapses a pinned ask to four lines with hover-to-expand, so no human turn can ever
// swallow the pane; the wake branches ahead of it (RecurringPromptLine, FrizzWake) ignore `sticky` and
// have no cap at all. A wake whose prose no parser recognizes takes FrizzWake's fallback — a full
// TranscriptCard holding the ENTIRE delivered text — so pinning one floated a ~1700px card over the
// transcript and the thread became unreadable (maintainer 2026-08-21: "this dialog covers the entire
// chat contents"). Capping that card would be the wrong repair, and it is not enough that most wakes
// now draw a one-line divider instead: frizz's own scheduler turn is not the human's ask, so it has no
// business in the current-ask band whatever its height, and a hairline pinned there stands exactly
// where the instruction the human is waiting on should be. It still renders in flow, in order.
// -1 when the transcript holds no human turn yet.
export function lastAskIndex(messages: readonly Pick<TranscriptMessage, "role" | "queued" | "peerFrom" | "wake">[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "user" && !m.queued && !m.peerFrom && !m.wake) return i
  }
  return -1
}
