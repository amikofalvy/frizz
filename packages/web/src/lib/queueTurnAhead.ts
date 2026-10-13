import { useEffect, useRef, useState } from "react"
import type { ThreadView, TranscriptMessage } from "@frizz/shared"
import { REST_CATCH_UP_MS, transcriptPastRest } from "./steering.ts"

// A TURN THE BOARD HAS NOT REPORTED YET, OPENED FROM SOMEWHERE ELSE — the queue card's reading of
// lib/steering transcriptPastRest, the predicate the thread view opens a turn on.
//
// A queue card is a rest. When its thread is steered the card leaves, and it leaves on the frame it was
// showing: TodosView freezes its transcript for the exit, on this tab's own steer stamp or on the board
// dropping the row. A steer from ANOTHER tab, a wake or `frizzctl steer` raises no stamp here, so the card
// has only the board to go on, and the board and the transcript report the turn's start in either order
// (about 40ms apart with the scripted worker, 2026-10-13). Board first is covered: the row drops, the card
// is frozen as it fades (3 of 3 on a stack). Transcript first was not. The landed message reached the
// card's cache while the board still had the thread at rest in the queue, and the card redrew around it —
// its window re-cut to the new message, 816px to 308px on the dissolve fixture, every card below it
// 508px up — and only then, when the board caught up, did it fade (4 of 4).
//
// So a transcript that moves PAST THE REST THE CARD WAS SHOWING, while the board still reports that rest,
// is not presented: the card keeps the transcript it had until the board takes it away, and fades on that.
// Held only when the card saw the message arrive — a card that MOUNTS on a transcript already ending in an
// unanswered message (a worker that died on it) draws what it has — and for at most REST_CATCH_UP_MS, so
// a board that never follows cannot keep a message off the card.
export type TurnAheadEvidence = Pick<TranscriptMessage, "role" | "kind" | "boundary" | "at" | "queued" | "deliveryState" | "sourceId">

/** The message that opened a turn the board has not reported, by identity; undefined when the transcript
 *  has not moved past the board's rest. */
export function turnAheadKey(t: ThreadView | undefined, messages: readonly TurnAheadEvidence[] | undefined): string | undefined {
  if (!messages || !transcriptPastRest(t, messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.queued) continue
    return m.sourceId ?? `at:${m.at ?? i}`
  }
  return undefined
}

/** Whether the card should go on showing the transcript it had: `messages` has moved past the rest the
 *  card's LAST COMMIT showed, and the board has not followed yet. */
export function useTurnAheadOfBoard(t: ThreadView | undefined, messages: readonly TurnAheadEvidence[] | undefined): boolean {
  // What the last commit presented: a loaded transcript at the board's rest. Read during render, written
  // after commit, so the render that first finds the transcript ahead asks what was on screen.
  const shownAtRest = useRef(false)
  const [expired, setExpired] = useState<string | undefined>(undefined)
  const ahead = turnAheadKey(t, messages)
  const key = shownAtRest.current ? ahead : undefined
  useEffect(() => {
    if (key === undefined) return
    const timer = setTimeout(() => setExpired(key), REST_CATCH_UP_MS)
    return () => clearTimeout(timer)
  }, [key])
  const held = key !== undefined && expired !== key
  const loaded = messages !== undefined && messages.length > 0
  useEffect(() => {
    shownAtRest.current = loaded && (held || ahead === undefined)
  }, [loaded, held, ahead])
  return held
}
