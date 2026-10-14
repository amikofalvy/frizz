import type { ChatMessage } from "../hooks.ts"
import { inQueuedTail } from "./restReply.ts"

// USER_TAIL_EXTRA lived here for one reason — ChatView imports this module, so it could not be declared
// beside STEP in ChatView — and that reason ended when the rhythm moved into components/rhythm.tsx,
// which imports nothing. It is re-exported so the row builder's callers keep one import.
export { USER_TAIL_EXTRA } from "../components/rhythm.tsx"

export interface VirtualTranscriptMessageRow {
  key: string
  message: ChatMessage
  messageIndex: number
  gap: number
}

// How close to the tail counts as "reading the tail". One constant for THREE things that must never
// drift apart: the virtualizer's own scrollEndThreshold, whether "Jump to latest" is hidden, and
// whether new content pins the reader to the bottom. The invariant the reader actually perceives is
// "if the jump button is hidden, I am attached" — two thresholds would break exactly that.
//
// This is a ROUNDING EPSILON, not a comfort band. It was 240 (a third of a pane), then 64; at both sizes
// a reader who nudged up a line or two to re-read something still counted as attached, so the next thing
// to land hauled them back to the bottom — measured at 24px above the bottom, a single append dragged the
// reader 346px (scripts/verify-full-nudge-threshold.mjs). The rule the reader expects is the literal one:
// if the bottom of the transcript is not at the bottom of the pane, nothing may move them. So the band has
// to cover only what a reader CANNOT have chosen — the sub-pixel residue that fractional layout and
// device-pixel rounding leave at the genuine bottom, which is where the `distance <= 1` write guard below
// already draws the line. A wheel notch is 40px+, so every deliberate scroll now detaches.
export const TAIL_FOLLOW_PX = 4

export interface TailFollowInput {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** The scroll height observed at the previous reconciliation (-1 before the first one). */
  previousScrollHeight: number
  /**
   * The scroller's own height at the previous reconciliation (-1, or absent, before the first one). The
   * VIEWPORT moving is the tail moving as surely as the content growing: a line of op counts arriving
   * over the prompt box takes its height out of the scroller, and with only the scroll height compared
   * that read as the reader having scrolled up 20px — detached under "Jump to latest" for the rest of
   * the turn (the drawer and the 820px page, the moment a worker launched a sub-agent; 2026-10-14).
   */
  previousClientHeight?: number
  /** Whether the reader was attached to the tail as of that previous reconciliation. */
  following: boolean
  /** The reader is actively driving the scroller (a wheel/touch/key gesture is in flight). */
  readerMoved: boolean
}

export interface TailFollow {
  following: boolean
  /** The scrollTop to write to stay attached, or null to leave the scroller alone. */
  scrollTop: number | null
}

// Reconcile "is the reader attached to the tail?" with the re-pin that keeps them there.
//
// The whole difficulty is telling the two causes of a growing distance-from-bottom apart, because they
// demand opposite responses: the READER scrolled up (leave them alone) versus the CONTENT grew under
// them (pull them back down). Distance alone cannot say which — so compare the scroll height. Same
// height means only the reader can have moved, so the current distance IS their intent and fully
// reclassifies attachment. A changed height means the tail moved under them, so their previous
// attachment carries over; a resize may only ADD attachment, and only by bringing the true bottom back
// to exactly where they already sit (a shrink, e.g. the Working… row retiring).
//
// The PANE resizing is the same case from the other side: the footer under the transcript grows (an
// ops line arrives, the composer gains a row) and the scroller loses those pixels while the content
// keeps its height, so the tail slides under the footer by exactly the amount it grew. Read on scroll
// height alone that frame is a reader scrolling up, and a reader at the tail was detached and handed
// "Jump to latest" by a 20px footer (layout sweep, 2026-10-14). So `previousClientHeight` counts as a
// resize too.
//
// This is deliberately not "recompute on scroll, follow on render": those two callbacks interleave in
// an order nothing here controls (the virtualizer's own scroll listener re-renders through React
// before our listener runs), and a follow that read a stale attachment yanked a reader who had just
// scrolled up straight back to the bottom.
export function nextTailFollow(input: TailFollowInput): TailFollow {
  const max = Math.max(input.scrollHeight - input.clientHeight, 0)
  const distance = max - input.scrollTop
  const resized = input.scrollHeight !== input.previousScrollHeight
    || (input.previousClientHeight !== undefined && input.previousClientHeight >= 0 && input.clientHeight !== input.previousClientHeight)
  const following = resized && !input.readerMoved
    ? input.following || distance <= 1
    : distance <= TAIL_FOLLOW_PX
  // Only ever WRITE in response to the content moving. A reader-driven scroll reclassifies attachment
  // and nothing more: correcting one there would mean every small scroll-up inside the threshold gets
  // instantly undone — the scroller literally fighting the wheel. Fractional layout also leaves a
  // sub-pixel residue at the genuine bottom, which must not provoke a write (and a scroll event) on
  // every commit forever; only close a gap a reader could actually see.
  if (!following || !resized || max <= 0 || distance <= 1) return { following, scrollTop: null }
  return { following, scrollTop: max }
}

export interface EarlierLoadGateInput {
  armed: boolean
  scrollTop: number
  readerMoved: boolean
  hasEarlier: boolean
  loading: boolean
}

export function earlierLoadGate(input: EarlierLoadGateInput): { armed: boolean; shouldLoad: boolean } {
  const armed = input.scrollTop > 640 ? true : input.armed
  const shouldLoad = armed
    && input.readerMoved
    && input.scrollTop <= 480
    && input.hasEarlier
    && !input.loading
  return { armed: shouldLoad ? false : armed, shouldLoad }
}

function legacyMessageKey(message: ChatMessage): string {
  return `legacy:${message.role}:${message.kind ?? "message"}:${message.at ?? ""}:${message.text}`
}

// `gapBetween` is ChatView's messageGap — the single expression of the between-message rhythm, injected
// rather than imported because ChatView imports this module. A row's `gap` renders ABOVE it, so the gap
// is charged to the row that FOLLOWS: that is what puts the extra air under whatever the previous
// message ended with (an inlined screenshot included) rather than under its text.
export function buildVirtualTranscriptMessageRows(
  messages: readonly ChatMessage[],
  rendersNothing: (message: ChatMessage) => boolean,
  gapBetween: (previous: ChatMessage, next: ChatMessage) => number,
): VirtualTranscriptMessageRow[] {
  const rows: VirtualTranscriptMessageRow[] = []
  const keyCounts = new Map<string, number>()
  let previous: ChatMessage | null = null

  messages.forEach((message, messageIndex) => {
    if (inQueuedTail(message) || rendersNothing(message)) return
    const baseKey = message.sourceId ?? legacyMessageKey(message)
    const duplicate = keyCounts.get(baseKey) ?? 0
    keyCounts.set(baseKey, duplicate + 1)
    rows.push({
      key: duplicate === 0 ? baseKey : `${baseKey}:${duplicate}`,
      message,
      messageIndex,
      gap: previous === null ? 0 : gapBetween(previous, message),
    })
    previous = message
  })

  return rows
}
