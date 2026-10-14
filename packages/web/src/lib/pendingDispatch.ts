import { useMemo } from "react"
import { proxy, useSnapshot } from "valtio"

// A DISPATCH THE SERVER HAS NOT SHOWN YET — the thread a prompt box just started, between the click and
// the board delta that carries its row.
//
// The prompt box used to say so with a card of its own ("Starting thread…" over the prompt's text), set
// between the box and the rail. That card took height for exactly as long as the dispatch call ran and
// then gave it back, so everything under it moved twice for one new row. Recorded on a project's
// sidebar, 2026-10-13 (three runs, a local stack whose dispatch answers in about half a second):
//
//   +13-22ms    the card mounts: the Queue label and every row move DOWN 73px
//   +485-580ms  the board delta lands first: the Running row appears UNDER the still-mounted card
//   +494-594ms  the call answers, the card unmounts: every row moves back UP 73px
//
// In the stacked layout (≤800px, the sidebar above the queue) the queue's cards made the same round
// trip. A real provider's dispatch takes seconds rather than half of one, so the rail sat shoved down
// for all of it.
//
// So the pending thread is kept HERE, where the rail can read it, and the rail draws it as the Running
// row it is about to become (StartingRow in Sidebar.tsx): one row appears at the click, and the real
// one takes its place without anything moving. The same shape as lib/steering.ts and
// lib/optimisticArchive.ts — a hint that asserts what the server is about to report and yields the
// moment it does.
export interface PendingDispatchEntry {
  key: number
  /** The Console scope the dispatch went to; undefined on a project's own page (lib/projectScope). */
  project: string | undefined
  backend: string
  model: string
  /** The thread's slug, once the dispatch call has answered. */
  slug?: string
}

const pending = proxy({ list: [] as PendingDispatchEntry[] })
// The board's thread ids at the moment of each dispatch, kept out of the proxy: a Set is not something
// valtio should wrap, and nothing renders from it directly.
const knownAt = new Map<number, ReadonlySet<string>>()
const expiries = new Map<number, ReturnType<typeof setTimeout>>()
let nextKey = 1

// How long an ANSWERED dispatch may stay pending for a board delta that has not come. The delta is
// published by the dispatch handler itself, so it normally lands within a frame or two of the answer
// (and usually before it); past this the row is a guess nobody should be looking at.
export const DISPATCH_LANDING_MS = 5_000

function drop(key: number): void {
  const timer = expiries.get(key)
  if (timer !== undefined) { clearTimeout(timer); expiries.delete(key) }
  knownAt.delete(key)
  const at = pending.list.findIndex((entry) => entry.key === key)
  if (at >= 0) pending.list.splice(at, 1)
}

/** A dispatch call is going out. `known` is every thread id the board holds right now. */
export function beginDispatch(entry: Omit<PendingDispatchEntry, "key" | "slug">, known: ReadonlySet<string>): number {
  const key = nextKey++
  knownAt.set(key, known)
  pending.list.push({ ...entry, key })
  return key
}

/** The call answered with the thread's slug. The entry stays until the board shows that thread. */
export function dispatchAnswered(key: number, slug: string): void {
  const entry = pending.list.find((candidate) => candidate.key === key)
  if (!entry) return
  entry.slug = slug
  expiries.set(key, setTimeout(() => drop(key), DISPATCH_LANDING_MS))
}

/** The call failed: no thread is coming. */
export function dispatchFailed(key: number): void {
  drop(key)
}

/**
 * The pending dispatches the board does not show yet, oldest first.
 *
 * An ANSWERED dispatch is matched by its slug. One still in flight has no slug, and the board delta that
 * carries its row usually beats the call's own answer, so it is matched by any thread the board has gained
 * since it was sent — each such thread claimed by one dispatch, oldest first. Without that the row would
 * be drawn twice (the stand-in and the real one) until the call answered.
 */
export function unlandedDispatches(
  entries: readonly PendingDispatchEntry[],
  boardIds: ReadonlySet<string>,
  known: (key: number) => ReadonlySet<string> | undefined = (key) => knownAt.get(key),
): PendingDispatchEntry[] {
  const claimed = new Set(entries.flatMap((entry) => (entry.slug ? [entry.slug] : [])))
  return entries.filter((entry) => {
    if (entry.slug) return !boardIds.has(entry.slug)
    const before = known(entry.key)
    for (const id of boardIds) {
      if (before?.has(id) || claimed.has(id)) continue
      claimed.add(id)
      return false
    }
    return true
  })
}

/** This surface's pending dispatches (`project` as useProjectScope gives it). */
export function usePendingDispatches(project: string | undefined): readonly PendingDispatchEntry[] {
  const list = useSnapshot(pending).list as readonly PendingDispatchEntry[]
  return useMemo(() => list.filter((entry) => entry.project === project), [list, project])
}
