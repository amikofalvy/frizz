import assert from "node:assert/strict"
import { test } from "node:test"
import { snapshot, subscribe } from "valtio"
import type { BoardDelta, BoardSnapshot, ThreadView } from "@frizz/shared"
import { applyDelta, boardThreadsNow, setBoard, store, threadSnapshotBySlug } from "./store.ts"
import { resolveThreadRoute } from "./lib/threadRouteState.ts"

// A thread on the board is a plain value, never a valtio proxy (store.ts plainThreads). On a board of
// 5,000 threads, proxying each one at the seed and again at the keyframe, then copying each into the
// first snapshot, was most of a page load's 550ms keyframe task and ~60MB of its heap; replacing a slot
// paid a walk of every thread. These cases pin what the store promises in exchange: the array is still
// reactive, a thread is the object the server sent, and every reader finds the replacement.

function row(id: string, over: Partial<ThreadView> = {}): ThreadView {
  return { id, title: id, runtime: "turn-idle", dependsOn: [], ...over } as unknown as ThreadView
}
function board(...threads: ThreadView[]): BoardSnapshot {
  return { projectDir: "/p", projectName: "p", projectLabel: "p", threads, errors: [], warnings: [] } as unknown as BoardSnapshot
}
function delta(seq: number, upserts: ThreadView[], removed: string[] = []): BoardDelta {
  return { type: "board-delta", seq, upserts, removed } as unknown as BoardDelta
}
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test("a keyframe's threads are stored as the very objects that arrived, and snapshots hold the same ones", () => {
  store.board = null
  const a = row("a"), b = row("b")
  setBoard(board(a, b))
  assert.equal(store.board!.threads[0], a, "not a proxy of it")
  assert.equal(store.board!.threads[1], b)
  assert.equal(boardThreadsNow()![0], a, "the snapshot holds the same object, not a frozen copy")
  assert.equal((snapshot(store).board as unknown as BoardSnapshot).threads[1], b)
})

test("a delta replaces a slot and notifies, and every lookup finds the replacement", async () => {
  store.board = null
  setBoard(board(row("a"), row("b"), row("c")))
  let notified = 0
  const stop = subscribe(store, () => notified++)
  const before = boardThreadsNow()
  const next = row("b", { title: "b, renamed" })
  assert.equal(applyDelta(delta(2, [next])), true)
  await flush()
  assert.ok(notified > 0, "replacing a slot still notifies subscribers")
  assert.equal(store.board!.threads[1], next)
  assert.notEqual(boardThreadsNow(), before, "a new snapshot of the array")
  assert.equal(boardThreadsNow()![0], before![0], "the threads that did not change are the same objects")
  assert.equal(threadSnapshotBySlug("b"), next)
  assert.equal(resolveThreadRoute(store.board, "b").kind, "found")
  stop()
})

test("deltas keep finding each thread's slot across adds, replaces and removals", () => {
  store.board = null
  setBoard(board(row("a"), row("b"), row("c")))
  applyDelta(delta(2, [row("d")]))
  applyDelta(delta(3, [row("a", { title: "a2" }), row("d", { title: "d2" })]))
  applyDelta(delta(4, [], ["b"]))
  applyDelta(delta(5, [row("c", { title: "c2" }), row("e")]))
  assert.deepEqual(store.board!.threads.map((t) => `${t.id}:${t.title}`), ["a:a2", "c:c2", "d:d2", "e:e"])
  assert.equal(threadSnapshotBySlug("c")?.title, "c2")
  assert.equal(threadSnapshotBySlug("e")?.id, "e")
  assert.equal(threadSnapshotBySlug("b"), undefined)
  // A new board starts its own table: the old one's slots must not leak into it.
  setBoard(board(row("e"), row("c")))
  applyDelta(delta(1, [row("c", { title: "c3" })]))
  assert.deepEqual(store.board!.threads.map((t) => `${t.id}:${t.title}`), ["e:e", "c:c3"])
  store.board = null
})
