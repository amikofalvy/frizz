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
    if (!transcriptBehindRest(t, cachedMessages(t.id) ?? [])) continue
    held.set(t.id, since)
  }
  return held
}
