import { useEffect, useRef, useState } from "react"
import type { ThreadView, TranscriptMessage } from "@frizz/shared"
import { inQueuedTail } from "./restReply.ts"

// THE REST THE BOARD HAS NOT REACHED YET — useTurnHeldForTranscript's mirror (lib/steering.ts), for the
// other order of the same two channels.
//
// A turn's end reaches the page twice: the board delta that says `turn-idle`, and the transcript push
// that carries the final message and its rest boundary. The board normally leads (one tailer tick sees
// both and publishes the board first), and lib/steering holds the turn on screen until the transcript
// follows. But the push is a FRESH read of the session file, taken a few milliseconds after the tick that
// asked for it, so a final record written inside that window is in the push and not in the tick's fold:
// the transcript says the agent rested while the board still says `running`, and stays that way until
// the next tick (measured with scripts/scripted-claude.mjs, 2026-10-13: 19-95ms later). The thread view
// drew that literally — the finished reply with `Thinking… 0s` under it and its fence still a fence —
// and then took the row away and folded the fence into its card a frame or two later: two geometry
// changes for one rest, on 1 of 60 turn ends with the script's default lags and 11 of 40 when the
// final record trails a tool result by 40ms.
//
// So a transcript that ENDS ON A REST THE VIEW HAS NOT SHOWN, arriving while the board still reports the
// turn, is not presented yet: the view keeps the transcript it was showing until the board rests, and the
// reply, its card and the Working row's departure land in one render. Three things end the hold besides
// the board: the transcript moving past that rest (the worker carried on — a Stop hook sent it back to
// work — so the rest was never the end), a transcript the view was not already showing (a page opened in
// this state draws what it has), and BOARD_CATCH_UP_MS, so a board that never follows cannot keep a
// reply off the screen.
export const BOARD_CATCH_UP_MS = 400

export type RestTailEvidence = Pick<TranscriptMessage, "kind" | "boundary" | "sourceId" | "at" | "queued"> & { restReply?: boolean }

/** The rest boundary a transcript ENDS on, by identity — bubbles pinned in the queued tail are not part of
 *  the turn — or undefined when its last landed message is anything else. */
export function trailingRestKey(messages: readonly RestTailEvidence[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (inQueuedTail(m)) continue
    return m.kind === "event" && m.boundary === "rest" ? m.sourceId ?? `rest@${m.at ?? i}` : undefined
  }
  return undefined
}

/** Whether `messages` carries a rest the board has not reached: the board still reports the turn, and the
 *  transcript ends on a rest boundary other than the one the view last presented (`shownRestKey`). */
export function restAheadOfBoard(t: ThreadView | undefined, messages: readonly RestTailEvidence[], shownRestKey: string | undefined): string | undefined {
  if (!t || (t.runtime !== "running" && t.runtime !== "spawning")) return undefined
  const key = trailingRestKey(messages)
  return key !== undefined && key !== shownRestKey ? key : undefined
}

/** The transcript as the thread view should present it: the live one, unless it carries a rest the board
 *  has not reached while the view was showing the turn — then the one already on screen, for at most
 *  BOARD_CATCH_UP_MS. Returned by identity whenever nothing is held. */
export function useTranscriptHeldForBoard<T extends RestTailEvidence>(t: ThreadView | undefined, messages: T[]): T[] {
  // What the LAST COMMIT presented: read during render, written after commit.
  const shown = useRef<{ messages: T[]; restKey: string | undefined } | null>(null)
  const [expired, setExpired] = useState<string | undefined>(undefined)
  const ahead = shown.current && shown.current.messages.length > 0 ? restAheadOfBoard(t, messages, shown.current.restKey) : undefined
  useEffect(() => {
    if (ahead === undefined) return
    const timer = setTimeout(() => setExpired(ahead), BOARD_CATCH_UP_MS)
    return () => clearTimeout(timer)
  }, [ahead])
  const presented = ahead !== undefined && expired !== ahead ? shown.current!.messages : messages
  useEffect(() => {
    if (shown.current?.messages !== presented) shown.current = { messages: presented, restKey: trailingRestKey(presented) }
  }, [presented])
  return presented
}
