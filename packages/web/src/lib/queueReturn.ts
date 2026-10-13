import type { ThreadView } from "@frizz/shared"
import { REST_CATCH_UP_MS, transcriptBehindRest, type RestEvidence } from "./steering.ts"

// A CARD COMING BACK TO THE QUEUE WAITS FOR ITS REPLY.
//
// A steered card leaves the queue the moment it is sent, and with it the only observer of its
// ["transcript", slug] query, so api/transcript-live.ts releases the thread's push subscription for the
// whole turn. When the turn ends, the board delta that puts the thread back in the queue arrives first;
// the card mounted on it and painted the copy cached from BEFORE the turn — the human's message with
// nothing under it, or with a "Rested without a sign-off" card describing the previous rest — until the
// refetch landed 15-34ms later and the reply grew the card (measured on real Haiku workers, 2026-10-13;
// in a queue short enough to be centred, every card on the page moved twice).
//
// So a card ENTERING the queue while its cached transcript is behind the rest the board reports
// (lib/steering transcriptBehindRest, the same test the thread view holds its turn on) is held out of the
// list until the transcript catches up, and never for longer than REST_CATCH_UP_MS. Holding is not
// leaving it unfetched: TodosView mounts a render-nothing observer for every held card, which is what
// starts the refetch (the board's newer lastActivityAt makes the cached copy stale, hooks.ts
// transcriptStaleTime) and re-subscribes the push.
//
// Holding the card is chosen over keeping a steered thread's transcript subscribed while its card is
// away. A live subscription alone does not close the gap — the push carrying the reply still trails the
// board's turn-idle by ~20ms (the tailer publishes the board first) — so the hold would be needed anyway,
// and the subscription would spend a slot of the socket's read budget (transcript-live MAX_LIVE) for the
// whole of every steered turn to save one ~20-45ms fetch at its end.
//
// Only ENTERING cards are held. `known` is null until the queue has rendered once for this board, so the
// cards a page opens on, or a project switch lands on, render as they always have.

// …AND A CACHE THAT STOPPED BEFORE THE HUMAN'S MESSAGE IS BEHIND TOO. transcriptBehindRest takes a
// trailing rest boundary as the transcript's own word that the turn ended, which is right for a view
// that watched the turn. A card's cache did not: its observer goes when the card unmounts, ~300ms after
// the send, and the server's echo of the message normally beats that (52-98ms on a local stack). When it
// does not — a slow server, a board that drops the card first — the cache still ends on the PREVIOUS
// turn's boundary, with at most this tab's ghost under it, and read as caught up: the card mounted over
// the transcript from before the turn and grew when the refetch landed (the dissolve fixture, once its
// transcripts ended on a boundary as real ones do: 3 of 3). The board says which boundary it is: one
// older than the message that opened the turn (`lastUserAt`) cannot be the one that closed it.
export function cacheEndsBeforeTurn(t: ThreadView, messages: readonly RestEvidence[]): boolean {
  if (t.runtime !== "turn-idle" && t.runtime !== "exited") return false
  const opened = Date.parse(t.lastUserAt ?? "")
  const said = Date.parse(t.lastAssistantAt ?? "")
  // Only a rest that FOLLOWS a human's message: a wake's turn moves no lastUserAt, and a message nobody
  // answered is not a turn that ended.
  if (!Number.isFinite(opened) || !Number.isFinite(said) || said < opened) return false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.queued) continue
    if (m.kind !== "event" || m.boundary !== "rest") return false
    const at = Date.parse(m.at ?? "")
    return Number.isFinite(at) && at < opened
  }
  return false
}

/** slug → when the hold began. */
export type ReturnHolds = ReadonlyMap<string, number>

export function returningHolds(
  prior: ReturnHolds,
  known: ReadonlySet<string> | null,
  items: readonly ThreadView[],
  cachedMessages: (slug: string) => readonly RestEvidence[] | undefined,
  now: number,
): Map<string, number> {
  const held = new Map<string, number>()
  for (const t of items) {
    const since = prior.get(t.id) ?? (known !== null && !known.has(t.id) ? now : undefined)
    if (since === undefined || now - since >= REST_CATCH_UP_MS) continue
    const cached = cachedMessages(t.id) ?? []
    if (!transcriptBehindRest(t, cached) && !cacheEndsBeforeTurn(t, cached)) continue
    held.set(t.id, since)
  }
  return held
}
