import assert from "node:assert/strict"
import { test } from "node:test"
import type { ThreadView } from "@frizz/shared"
import { consoleCardOrder, projectBlocks } from "./consoleBoard.ts"

const t = (id: string): ThreadView => ({ id }) as ThreadView

test("by project, the Queue band and its cards group into the rail's order, keeping each project's queue order", () => {
  // As the queue orders them: oldest first across every project.
  const waiting = ["b~1", "a~1", "c~1", "a~2", "b~2"].map(t)
  const order = ["a", "b", "c"]
  assert.deepEqual(consoleCardOrder(waiting, "project", order).map((x) => x.id), ["a~1", "a~2", "b~1", "b~2", "c~1"])
  // By status the queue's own order stands, every project mixed.
  assert.deepEqual(consoleCardOrder(waiting, "status", order).map((x) => x.id), ["b~1", "a~1", "c~1", "a~2", "b~2"])
})

test("a project block holds its waiting rows, then its running ones, and a project with neither has no block", () => {
  const blocks = projectBlocks([t("b~w")], [t("a~r1"), t("b~r"), t("a~r2")], ["a", "b", "c"])
  assert.deepEqual(
    blocks.map((b) => [b.project, b.waiting.map((x) => x.id), b.running.map((x) => x.id)]),
    [["a", [], ["a~r1", "a~r2"]], ["b", ["b~w"], ["b~r"]]],
  )
})

test("a project the rail no longer lists keeps its block, last, rather than losing its threads", () => {
  const blocks = projectBlocks([t("gone~w"), t("a~w")], [], ["a"])
  assert.deepEqual(blocks.map((b) => b.project), ["a", "gone"])
})

test("a thread that is starting opens its project's block, in the rail's order, and joins a block that exists", () => {
  const starting = [
    { key: 1, project: "c", backend: "claude", model: "opus" },
    { key: 2, project: "a", backend: "codex", model: "sol" },
    // A project page's dispatch names no project and belongs to no block.
    { key: 3, project: undefined, backend: "claude", model: "opus" },
  ]
  const blocks = projectBlocks([t("b~w")], [t("a~r")], ["a", "b", "c"], starting)
  assert.deepEqual(
    blocks.map((b) => [b.project, b.waiting.length, b.running.length, b.starting.map((e) => e.key)]),
    [["a", 0, 1, [2]], ["b", 1, 0, []], ["c", 0, 0, [1]]],
  )
  // Without one, a project with nothing waiting or running still has no block.
  assert.deepEqual(projectBlocks([t("b~w")], [t("a~r")], ["a", "b", "c"]).map((b) => b.project), ["a", "b"])
})
