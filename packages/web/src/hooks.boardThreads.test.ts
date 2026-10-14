import assert from "node:assert/strict"
import { test } from "node:test"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { queuedThreadsNow } from "./hooks.ts"
import { boardThreadsNow, store } from "./store.ts"

// The queue page and the rail read the board's threads as valtio's immutable SNAPSHOT (hooks.ts § The
// board's threads, read without tracking). What makes that cheap is identity: a thread nobody touched is
// the same object from one board state to the next, and the queue's list is the same ARRAY until a queued
// thread changes — so a page of cards does not re-render because something else on the board ticked.

function row(id: string, over: Partial<ThreadView> = {}): ThreadView {
  return { id, title: id, kind: "session", status: "active", runtime: "turn-idle", archived: false, needsYou: false, lastActivityAt: "2026-10-13T12:00:00.000Z", ...over } as unknown as ThreadView
}
const live = () => store.board as BoardSnapshot

test("an untouched thread is the same snapshot object across a change to another thread", () => {
  store.board = { threads: [row("q", { needsYou: true }), row("r", { runtime: "running" }), row("d", { archived: true })], errors: [] } as unknown as BoardSnapshot
  const before = boardThreadsNow()!
  live().threads[1].lastActivityAt = "2026-10-13T12:00:05.000Z"
  const after = boardThreadsNow()!
  assert.notEqual(after, before, "the list is a new array: one of its rows changed")
  assert.equal(after[0], before[0])
  assert.equal(after[2], before[2])
  assert.notEqual(after[1], before[1])
})

test("the queue's list keeps its identity while only non-queued threads change", () => {
  store.board = { threads: [row("q1", { needsYou: true }), row("r", { runtime: "running" }), row("q2", { needsYou: true }), row("d", { archived: true })], errors: [] } as unknown as BoardSnapshot
  const first = queuedThreadsNow()
  assert.deepEqual(first.map((t) => t.id), ["q1", "q2"])
  assert.equal(queuedThreadsNow(), first, "asked again with nothing changed")

  live().threads[1].lastActivityAt = "2026-10-13T12:00:05.000Z" // the running thread ticks
  live().threads.push(row("d2", { archived: true })) // a Done thread arrives
  assert.equal(queuedThreadsNow(), first, "neither is in the queue, so the queue's readers have nothing to do")
})

test("a change to a queued thread, or to the set, is a new list", () => {
  store.board = { threads: [row("q1", { needsYou: true }), row("q2", { needsYou: true }), row("r", { runtime: "running" })], errors: [] } as unknown as BoardSnapshot
  const first = queuedThreadsNow()

  live().threads[0].title = "renamed"
  const renamed = queuedThreadsNow()
  assert.notEqual(renamed, first)
  assert.equal(renamed[1], first[1], "the card that did not change is still the same object")

  live().threads[1].needsYou = false // q2 leaves the queue
  const left = queuedThreadsNow()
  assert.deepEqual(left.map((t) => t.id), ["q1"])

  live().threads[2].needsYou = true // the running thread comes to rest on a card
  live().threads[2].runtime = "turn-idle"
  assert.deepEqual(queuedThreadsNow().map((t) => t.id), ["q1", "r"])

  store.board = null
  assert.deepEqual(queuedThreadsNow(), [], "no board, no queue")
})
