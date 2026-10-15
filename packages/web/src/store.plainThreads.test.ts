import assert from "node:assert/strict"
import { test } from "node:test"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { proxy, ref, snapshot, subscribe } from "valtio"
import type { BoardDelta, BoardSnapshot, ThreadView } from "@frizz/shared"
import { applyDelta, boardThreadsNow, isPlainThreadArray, setBoard, store, threadBySlug, threadSnapshotBySlug } from "./store.ts"
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

// useSnapshot's own machinery (valtio/react tracks a render's reads with proxy-compare), and the SAME
// copy of it valtio loads — its ESM build, beside valtio. The web package does not depend on
// proxy-compare itself, and the CommonJS build `require` would find is a second instance that never sees
// the marks valtio sets (which is exactly what the `ref` control below depends on).
const proxyCompareDir = dirname(createRequire(import.meta.resolve("valtio")).resolve("proxy-compare/package.json"))
const { createProxy, isChanged } = (await import(pathToFileURL(join(proxyCompareDir, "dist/index.js")).href)) as {
  createProxy: <T extends object>(obj: T, affected: WeakMap<object, unknown>) => T
  isChanged: (prev: unknown, next: unknown, affected: WeakMap<object, unknown>) => boolean
}

test("the threads array is a plain value, replaced by a delta and never written once a snapshot holds it", () => {
  store.board = null
  setBoard(board(row("a"), row("b"), row("c")))
  const first = store.board!.threads
  assert.ok(isPlainThreadArray(first), "not a valtio proxy")
  assert.equal(boardThreadsNow(), first, "a snapshot shares the array rather than copying it, slot by slot")
  applyDelta(delta(2, [row("b", { title: "b2" })]))
  const second = boardThreadsNow()!
  assert.notEqual(second, first, "a delta replaces the array")
  assert.equal(first[1]!.title, "b", "and leaves the one an earlier snapshot holds as it was")
  assert.equal(second[1]!.title, "b2")
  assert.equal(second[0], first[0], "the threads that did not change are the same objects")
  applyDelta(delta(3, [], ["a"]))
  assert.deepEqual(second.map((t) => t.id), ["a", "b", "c"], "a removal copies too")
  assert.deepEqual(boardThreadsNow()!.map((t) => t.id), ["b", "c"])
  // A meta-only delta leaves the array alone.
  const before = boardThreadsNow()
  applyDelta({ ...delta(4, []), meta: { projectDir: "/p", projectName: "p", projectLabel: "p", errors: ["x"], warnings: [] } } as BoardDelta)
  assert.equal(boardThreadsNow(), before)
  assert.deepEqual(store.board!.errors, ["x"])
  store.board = null
})

test("a render that looked one thread up re-renders for THAT thread's delta, and not for another's", () => {
  store.board = null
  setBoard(board(row("a"), row("b"), row("c")))
  // What useSnapshot does: a tracking view over the snapshot, the render's reads recorded in `affected`.
  const affected = new WeakMap<object, unknown>()
  const first = snapshot(store)
  const view = createProxy(first, affected)
  // The card draws its thread's title.
  assert.equal(threadBySlug(view.board as BoardSnapshot, "c")?.title, "c")
  applyDelta(delta(2, [row("a", { title: "a2" })]))
  assert.equal(isChanged(first, snapshot(store), affected), false, "another thread's delta does not touch what this render read")
  applyDelta(delta(3, [row("c", { runtime: "running" } as Partial<ThreadView>)]))
  assert.equal(isChanged(first, snapshot(store), affected), false, "nor does a change to a field of its own it never read")
  applyDelta(delta(4, [row("c", { title: "c2" })]))
  assert.equal(isChanged(first, snapshot(store), affected), true, "a change to what it drew does")
  store.board = null

  // The control, and the reason store.ts reaches for valtio's canProxy hook rather than `ref`: an array
  // marked with `ref` is shared too, but proxy-compare is told not to look inside it, so every delta
  // would re-render every card that looked anything up.
  const refBoard = proxy({ threads: ref([row("a"), row("b"), row("c")]) })
  const refAffected = new WeakMap<object, unknown>()
  const refFirst = snapshot(refBoard)
  const refView = createProxy(refFirst, refAffected)
  assert.equal(refView.threads[2]!.id, "c")
  refBoard.threads = ref([row("a", { title: "a2" }), refBoard.threads[1]!, refBoard.threads[2]!])
  assert.equal(isChanged(refFirst, snapshot(refBoard), refAffected), true, "a ref'd array re-renders on any delta")
})
