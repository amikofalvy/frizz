import assert from "node:assert/strict"
import test from "node:test"
import { unlandedDispatches, type PendingDispatchEntry } from "./pendingDispatch.ts"

const entry = (key: number, slug?: string): PendingDispatchEntry => ({ key, project: undefined, backend: "claude", model: "opus", slug })
const board = (...ids: string[]) => new Set(ids)
// The board as it stood when each dispatch was sent.
const knownAs = (table: Record<number, string[]>) => (key: number) => new Set(table[key] ?? [])

test("a dispatch still in flight is pending until the board gains a thread", () => {
  const known = knownAs({ 1: ["a", "b"] })
  assert.deepEqual(unlandedDispatches([entry(1)], board("a", "b"), known).map((e) => e.key), [1])
  // The board delta beat the call's answer: the new thread is this dispatch's, so its stand-in goes.
  assert.deepEqual(unlandedDispatches([entry(1)], board("a", "b", "new"), known), [])
})

test("an answered dispatch is pending until the board shows its own slug", () => {
  const known = knownAs({ 1: ["a"] })
  assert.deepEqual(unlandedDispatches([entry(1, "mine")], board("a", "someone-elses"), known).map((e) => e.key), [1])
  assert.deepEqual(unlandedDispatches([entry(1, "mine")], board("a", "mine"), known), [])
})

test("two dispatches in flight: one new thread lands one of them, oldest first", () => {
  const known = knownAs({ 1: ["a"], 2: ["a"] })
  assert.deepEqual(unlandedDispatches([entry(1), entry(2)], board("a", "first"), known).map((e) => e.key), [2])
  assert.deepEqual(unlandedDispatches([entry(1), entry(2)], board("a", "first", "second"), known), [])
})

test("a thread an answered dispatch names is not counted for another one still in flight", () => {
  const known = knownAs({ 1: ["a"], 2: ["a"] })
  // #1 answered as "first" and has landed; #2 has not been answered and nothing else is new.
  assert.deepEqual(unlandedDispatches([entry(1, "first"), entry(2)], board("a", "first"), known).map((e) => e.key), [2])
})

test("a thread that was already on the board when the dispatch was sent never lands it", () => {
  const known = knownAs({ 1: ["a", "b"] })
  assert.deepEqual(unlandedDispatches([entry(1)], board("b", "a"), known).map((e) => e.key), [1])
})
