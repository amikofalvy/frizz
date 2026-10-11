import assert from "node:assert/strict"
import { test } from "node:test"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { dropProject, keyThread, mergeDelta, mergeKeyframe } from "./consoleFeed.ts"

const thread = (id: string, over: Partial<ThreadView> = {}): ThreadView => ({ id, title: id, dependsOn: [], ...over }) as ThreadView
const union = (): BoardSnapshot => ({ projectDir: "", projectName: "Console", projectLabel: "Console", threads: [], errors: [], warnings: [] })
const board = (threads: ThreadView[], over: Partial<BoardSnapshot> = {}): BoardSnapshot =>
  ({ projectDir: "/p", projectName: "p", threads, errors: [], warnings: [], ...over }) as BoardSnapshot

test("a thread joins the merged board under its key, and so do the threads it depends on", () => {
  const keyed = keyThread("nub", thread("fix-auth", { dependsOn: ["spike"] }))
  assert.equal(keyed.id, "nub~fix-auth")
  assert.deepEqual(keyed.dependsOn, ["nub~spike"])
})

test("one project's keyframe replaces that project's threads and no one else's", () => {
  const merged = union()
  mergeKeyframe(merged, "nub", board([thread("a"), thread("b")]))
  mergeKeyframe(merged, "frizz", board([thread("a")]))
  mergeKeyframe(merged, "nub", board([thread("c")]))
  assert.deepEqual(merged.threads.map((x) => x.id).sort(), ["frizz~a", "nub~c"])
})

test("the same slug in two projects is two threads", () => {
  const merged = union()
  mergeKeyframe(merged, "nub", board([thread("fix-auth", { title: "nub's" })]))
  mergeKeyframe(merged, "frizz", board([thread("fix-auth", { title: "frizz's" })]))
  assert.deepEqual(merged.threads.map((x) => [x.id, x.title]).sort(), [["frizz~fix-auth", "frizz's"], ["nub~fix-auth", "nub's"]])
})

test("a delta upserts and removes under its own project's keys", () => {
  const merged = union()
  mergeKeyframe(merged, "nub", board([thread("a"), thread("b")]))
  mergeKeyframe(merged, "frizz", board([thread("b")]))
  mergeDelta(merged, "nub", { type: "board-delta", seq: 2, upserts: [thread("a", { title: "renamed" }), thread("c")], removed: ["b"] } as never)
  assert.deepEqual(merged.threads.map((x) => [x.id, x.title]).sort(), [["frizz~b", "b"], ["nub~a", "renamed"], ["nub~c", "c"]])
})

test("a project that leaves the Console takes exactly its threads with it", () => {
  const merged = union()
  mergeKeyframe(merged, "nub", board([thread("a")]))
  mergeKeyframe(merged, "nub-tools", board([thread("a")]))
  dropProject(merged, "nub")
  assert.deepEqual(merged.threads.map((x) => x.id), ["nub-tools~a"])
})

test("a keyframe's board-level identity is not the merged board's", () => {
  const merged = union()
  mergeKeyframe(merged, "nub", board([], { projectName: "nub", projectSlug: "nub", homeDir: "/Users/x" }))
  assert.equal(merged.projectName, "Console")
  assert.equal(merged.homeDir, "/Users/x", "the machine's home directory is the same whichever project says it")
})
