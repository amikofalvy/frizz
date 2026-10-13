import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { restAheadOfBoard, trailingRestKey } from "./restAhead.ts"

// The transcript push is a fresh read taken a few ms after the tailer tick that asked for it, so it can
// carry a turn's final record — and its rest boundary — one tick before the board says `turn-idle`.
const thread = (runtime: ThreadView["runtime"]) => ({ id: "t", runtime } as unknown as ThreadView)
const said = (id: string) => ({ sourceId: id })
const human = (id: string) => ({ sourceId: id })
const rest = (id: string) => ({ sourceId: `${id}#rest`, kind: "event" as const, boundary: "rest" as const })
const ghost = { sourceId: "q", queued: true }

test("the rest a transcript ends on is named by its boundary — a queued bubble under it is not part of the turn", () => {
  assert.equal(trailingRestKey([said("a"), rest("a")]), "a#rest")
  assert.equal(trailingRestKey([said("a"), rest("a"), ghost]), "a#rest")
  assert.equal(trailingRestKey([said("a"), rest("a"), human("u")]), undefined, "the turn moved on")
  assert.equal(trailingRestKey([said("a"), rest("a"), { ...ghost, restReply: true }]), undefined, "a send drawn inline has ended the rest")
  assert.equal(trailingRestKey([]), undefined)
  // A boundary with no id still has to be told from the previous one.
  assert.notEqual(trailingRestKey([{ kind: "event", boundary: "rest", at: "2026-10-13T11:00:01.000Z" }]), trailingRestKey([{ kind: "event", boundary: "rest", at: "2026-10-13T11:00:09.000Z" }]))
})

test("a NEW rest under a board that still reports the turn is ahead of it", () => {
  const before = [said("a"), rest("a"), human("u")]
  const after = [...before, said("b"), rest("b")]
  assert.equal(restAheadOfBoard(thread("running"), after, trailingRestKey(before)), "b#rest")
  assert.equal(restAheadOfBoard(thread("spawning"), after, undefined), "b#rest")
})

test("the board resting, or the transcript moving past the rest, ends it", () => {
  const after = [said("a"), rest("a"), human("u"), said("b"), rest("b")]
  assert.equal(restAheadOfBoard(thread("turn-idle"), after, "a#rest"), undefined, "the board caught up: both land together")
  assert.equal(restAheadOfBoard(thread("exited"), after, "a#rest"), undefined)
  assert.equal(restAheadOfBoard(undefined, after, "a#rest"), undefined)
  // The worker carried on (a Stop hook sent it back to work): the rest was never the end.
  assert.equal(restAheadOfBoard(thread("running"), [...after, human("hook")], "a#rest"), undefined)
})

test("the rest the view already shows is not ahead: a turn the board starts before its message lands", () => {
  // The board's `running` delta leads the push carrying the human's message, so for a beat a running
  // board sits over a transcript that still ends on the PREVIOUS rest. That one is on screen; holding
  // it would hold nothing, and must not start a timer.
  const resting = [said("a"), rest("a")]
  assert.equal(restAheadOfBoard(thread("running"), resting, trailingRestKey(resting)), undefined)
})
