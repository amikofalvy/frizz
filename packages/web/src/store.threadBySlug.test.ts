import assert from "node:assert/strict"
import { test } from "node:test"
import { snapshot } from "valtio"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { boardThreadsNow, store, threadBySlug, threadSnapshotBySlug } from "./store.ts"

// threadBySlug is asked once per card per render, by several components of each card, and once per
// live transcript on every board change. As a `find` it read the id of every thread ahead of the one it
// wanted — through useBoard()'s tracking view, each of those reads was also recorded as something the
// asking component depends on. A board with 1,000 Done threads paid 7ms of a send's click for it in a
// production build (2026-10-13). These cases pin the two halves of the replacement: it reads ONE row,
// and it is never wrong about a board the table does not describe.

function rows(...ids: string[]): ThreadView[] {
  return ids.map((id) => ({ id, title: id, lastActivityAt: "2026-10-13T12:00:00.000Z" }) as unknown as ThreadView)
}
function setBoard(...ids: string[]): void {
  store.board = { threads: rows(...ids), errors: [] } as unknown as BoardSnapshot
}
/** A board whose thread array counts how many of its rows a lookup touches. */
function counting(threads: readonly ThreadView[]): { board: BoardSnapshot; touched: () => number } {
  let n = 0
  const counted = new Proxy(threads as ThreadView[], {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) n++
      return Reflect.get(target, key, receiver)
    },
  })
  return { board: { threads: counted, errors: [] } as unknown as BoardSnapshot, touched: () => n }
}

test("the live board answers with its own live row, by one indexed read", () => {
  setBoard("a", "b", "c")
  const live = store.board as BoardSnapshot
  assert.equal(threadBySlug(live, "b"), live.threads[1], "the live row itself")
  assert.equal(threadBySlug(live, "c")?.id, "c")
  assert.equal(threadBySlug(live, "nope"), undefined)
  assert.equal(threadBySlug(live, null), undefined)
  assert.equal(threadBySlug(null, "a"), undefined)
})

test("the table follows the board: a removed thread is gone, a moved one is found where it now is", () => {
  setBoard("a", "b", "c")
  const live = store.board as BoardSnapshot
  assert.equal(threadBySlug(live, "c"), live.threads[2])
  live.threads.splice(0, 1) // "a" leaves; "b" and "c" each move up one
  assert.equal(threadBySlug(live, "a"), undefined)
  assert.equal(threadBySlug(live, "b"), live.threads[0])
  assert.equal(threadBySlug(live, "c"), live.threads[1])
  live.threads.push(...rows("d"))
  assert.equal(threadBySlug(live, "d"), live.threads[2])
  assert.equal(threadSnapshotBySlug("d"), boardThreadsNow()?.[2], "the snapshot reader shares the table")
})

test("a board in hand that matches the store's is read at ONE row, however long the list ahead of it", () => {
  setBoard(...Array.from({ length: 1000 }, (_, i) => `done-${i}`), "the-card")
  const view = counting(boardThreadsNow()!)
  assert.equal(threadBySlug(view.board, "the-card")?.id, "the-card")
  assert.equal(view.touched(), 1, "a find would have touched 1,001")
})

test("an OLDER view of the board is still answered from itself, never from the table", () => {
  setBoard("a", "b", "c")
  const older = snapshot(store).board as unknown as BoardSnapshot
  ;(store.board as BoardSnapshot).threads.splice(0, 1) // the store moves on: "a" gone, "b" now first
  // The table says "b" is at 0 and has no "a". The older view has "a" at 0 and "b" at 1.
  assert.equal(threadBySlug(older, "b"), older.threads[1])
  assert.equal(threadBySlug(older, "a"), older.threads[0], "absent from the table is not absent from this board")
  assert.equal(threadBySlug(older, "c"), older.threads[2])
})

test("a board that is not the store's at all — a fixture's, a test's — is searched as before", () => {
  setBoard("x", "y", "z")
  const other = { threads: rows("z", "q", "x"), errors: [] } as unknown as BoardSnapshot
  assert.equal(threadBySlug(other, "x"), other.threads[2], "the table's position 0 holds z here")
  assert.equal(threadBySlug(other, "q"), other.threads[1])
  assert.equal(threadBySlug(other, "y"), undefined, "on the store's board, not on this one")
  store.board = null
  assert.equal(threadBySlug(other, "z"), other.threads[0], "and with no store board there is no table to consult")
})
