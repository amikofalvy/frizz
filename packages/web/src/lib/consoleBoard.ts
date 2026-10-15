import { proxy, useSnapshot } from "valtio"
import type { ThreadView } from "@frizz/shared"
import { activeBandThread } from "@frizz/shared"
import { orderByInteraction, orderQueue, queued } from "../groups.ts"
import type { QueueDirection } from "../groups.ts"
import type { PendingDispatchEntry } from "./pendingDispatch.ts"
import { partitionBoard } from "./boardPartition.ts"
import { keyProject } from "./threadKey.ts"

// THE CONSOLE'S TWO BANDS AND ITS TWO GROUPINGS.
//
// The Console is a queue, not an archive: it draws the threads waiting on the operator (a project's
// Queue band, `queued`) and the ones in flight (its Running band, `activeBandThread`) — the same two
// predicates the rail counts with, so a square's badge and the Console's rows for that project agree.
// There is no Snoozed and no Done here; those live on each project's own board.
//
// A pinned thread is not lifted into a band of its own as it is on a project's board. It sits in the
// band its state puts it in, wearing its pin, so the Queue band reads in exactly the order of the cards
// beside it — which is the order the operator works through.
//
// GROUPED BY STATUS, the two bands hold every project's rows mixed, each row wearing its project's
// square. GROUPED BY PROJECT, each project with anything waiting or running is one block, in the rail's
// order, its waiting rows first and its running rows after (RUNNING_CAP of them until asked for more).
// The cards follow whichever the sidebar draws.

export type ConsoleGroup = "status" | "project"

const GROUP_KEY = "frizz:console-group"

/** How many running rows a project's block shows before "Show more". */
export const RUNNING_CAP = 3

function readGroup(): ConsoleGroup {
  try {
    return localStorage.getItem(GROUP_KEY) === "status" ? "status" : "project"
  } catch {
    return "project"
  }
}

const state = proxy({
  group: typeof window === "undefined" ? ("project" as ConsoleGroup) : readGroup(),
  /** Projects whose running rows are expanded past RUNNING_CAP. This visit's, not remembered. */
  expanded: {} as Record<string, boolean>,
})

export function useConsoleGroup(): ConsoleGroup {
  return useSnapshot(state).group
}

export function setConsoleGroup(group: ConsoleGroup): void {
  state.group = group
  try {
    localStorage.setItem(GROUP_KEY, group)
  } catch {
    // Not remembered, but it holds for this page.
  }
}

export function useRunningExpanded(project: string): boolean {
  return useSnapshot(state).expanded[project] === true
}

export function setRunningExpanded(project: string, expanded: boolean): void {
  state.expanded[project] = expanded
}

// Both bands are asked of the LIVE threads only (lib/boardPartition.ts): a settled thread is archived and
// at rest, so it is neither waiting nor running, and the merged board holds every project's Done
// history. Asking all of them was 0.9ms of every delta at 5,000 threads (CPU profile, a streaming turn
// with its drawer open on the Console), and it grew with each project's history.

/** Every project's waiting threads, in the queue's own order. */
export function consoleQueue(threads: readonly ThreadView[], direction: QueueDirection): ThreadView[] {
  return orderQueue(partitionBoard(threads).live.filter(queued), direction)
}

/** Every project's running threads, most recently touched first — a project board's Running order. */
export function consoleRunning(threads: readonly ThreadView[]): ThreadView[] {
  return orderByInteraction(partitionBoard(threads).live.filter(activeBandThread))
}

export interface ProjectBlock {
  project: string
  waiting: ThreadView[]
  running: ThreadView[]
  /** Dispatches to this project whose rows the board has not delivered yet (lib/pendingDispatch), oldest first. */
  starting: PendingDispatchEntry[]
}

/**
 * One block per project with anything waiting or running, in `order` (the rail's). Rows keep the order
 * they arrive in, so each block's waiting rows are in queue order. A project missing from `order` — one
 * whose threads are still on the board after the rail dropped it — goes last rather than vanishing.
 *
 * A thread that is STARTING counts as something running: a dispatch to a project with nothing else on
 * the Console opens that project's block at the click, where the thread's own row then lands, instead
 * of the block arriving with the row and pushing every block under it down a second time.
 */
export function projectBlocks(
  waiting: readonly ThreadView[],
  running: readonly ThreadView[],
  order: readonly string[],
  starting: readonly PendingDispatchEntry[] = [],
): ProjectBlock[] {
  const blocks = new Map<string, ProjectBlock>()
  const block = (project: string) => {
    let b = blocks.get(project)
    if (!b) blocks.set(project, (b = { project, waiting: [], running: [], starting: [] }))
    return b
  }
  for (const t of waiting) block(keyProject(t.id) ?? "").waiting.push(t)
  for (const t of running) block(keyProject(t.id) ?? "").running.push(t)
  for (const entry of starting) if (entry.project !== undefined) block(entry.project).starting.push(entry)
  const rank = new Map(order.map((project, i) => [project, i]))
  return [...blocks.values()].sort((a, b) => (rank.get(a.project) ?? order.length) - (rank.get(b.project) ?? order.length))
}

/** The Queue band's rows — and so the cards — in the order the sidebar draws them for `group`. */
export function consoleCardOrder(waiting: readonly ThreadView[], group: ConsoleGroup, order: readonly string[]): ThreadView[] {
  if (group === "status") return [...waiting]
  return projectBlocks(waiting, [], order).flatMap((b) => b.waiting)
}
