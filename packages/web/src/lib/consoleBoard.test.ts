import assert from "node:assert/strict"
import { test } from "node:test"
import type { ThreadView } from "@frizz/shared"
import { consoleCardOrder, consoleDone, consolePinPlacements, consoleSnoozed, projectBlocks } from "./consoleBoard.ts"

const t = (id: string): ThreadView => ({ id }) as ThreadView
const pinned = (id: string, consolePinnedAt: string, over: Partial<ThreadView> = {}): ThreadView =>
  ({ id, kind: "session", consolePinnedAt, ...over }) as ThreadView

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

test("by status, the Console-pinned cards lead in the shelf's order; a project's own pin moves nothing", () => {
  const waiting = [
    t("b~1"),
    pinned("a~1", "2026-10-02T00:00:00.000Z"),
    { ...t("c~1"), kind: "session", pinnedAt: "2026-10-01T00:00:00.000Z" } as ThreadView,
    pinned("a~2", "2026-10-01T00:00:00.000Z"),
    t("b~2"),
  ]
  assert.deepEqual(consoleCardOrder(waiting, "status", ["a", "b", "c"]).map((x) => x.id), ["a~2", "a~1", "b~1", "c~1", "b~2"])
  // By project the Console's shelf plays no part: each block keeps its queue order.
  assert.deepEqual(consoleCardOrder(waiting, "project", ["a", "b", "c"]).map((x) => x.id), ["a~1", "a~2", "b~1", "b~2", "c~1"])
})

// The band as the board would sort it: by instant, then key.
function apply(shelf: ThreadView[], writes: { id: string; at: string }[]): string[] {
  const at = new Map(shelf.map((x) => [x.id, x.consolePinnedAt!]))
  for (const w of writes) at.set(w.id, w.at)
  return [...at].sort(([a, x], [b, y]) => x.localeCompare(y) || a.localeCompare(b)).map(([id]) => id)
}

test("a drag in the Console's pinned band is ONE write when there is room between the new neighbours", () => {
  const shelf = [
    pinned("a~x", "2026-10-01T00:00:00.000Z"),
    pinned("b~y", "2026-10-02T00:00:00.000Z"),
    pinned("a~z", "2026-10-03T00:00:00.000Z"),
  ]
  // Every arrangement of the three, each reached by one write.
  for (const next of [
    ["a~x", "a~z", "b~y"],
    ["b~y", "a~x", "a~z"],
    ["b~y", "a~z", "a~x"],
    ["a~z", "a~x", "b~y"],
    ["a~z", "b~y", "a~x"],
  ]) {
    const writes = consolePinPlacements(shelf, next)
    assert.deepEqual(apply(shelf, writes), next, `order ${next.join(",")}`)
    assert.ok(writes.length <= 1 || next.join() === "a~z,b~y,a~x", `order ${next.join(",")} is one write`)
  }
  // To the top: a minute above the top row.
  assert.deepEqual(consolePinPlacements(shelf, ["a~z", "a~x", "b~y"]), [{ id: "a~z", at: "2026-09-30T23:59:00.000Z" }])
  // To the bottom: a millisecond past the last row, so a pin made afterwards (stamped now) still lands below it.
  assert.deepEqual(consolePinPlacements(shelf, ["b~y", "a~z", "a~x"]), [{ id: "a~x", at: "2026-10-03T00:00:00.001Z" }])
  assert.deepEqual(consolePinPlacements(shelf, shelf.map((x) => x.id)), [], "the same order writes nothing")
})

test("with no room between the neighbours, the shelf's own instants are dealt again, strictly increasing", () => {
  // b and c were pinned in the same millisecond, so nothing fits between them.
  const shelf = [
    pinned("p~a", "2026-10-01T00:00:00.000Z"),
    pinned("q~b", "2026-10-02T00:00:00.000Z"),
    pinned("p~c", "2026-10-02T00:00:00.000Z"),
    pinned("q~d", "2026-10-03T00:00:00.000Z"),
    pinned("p~e", "2026-10-04T00:00:00.000Z"),
  ]
  const next = ["p~a", "q~b", "p~e", "p~c", "q~d"] // e up between the tied b and c
  const writes = consolePinPlacements(shelf, next)
  assert.deepEqual(apply(shelf, writes), next)
  const at = new Map([...shelf.map((x) => [x.id, x.consolePinnedAt!] as const), ...writes.map((w) => [w.id, w.at] as const)])
  const instants = next.map((id) => at.get(id)!)
  assert.ok(instants.every((v, i) => i === 0 || v > instants[i - 1]!), "no two rows are left tied")
  assert.ok(writes.every((w) => w.at <= "2026-10-04T00:00:00.000Z"), "no instant passes the shelf's latest, so a new pin still lands last")
  assert.ok(!writes.some((w) => w.id === "p~a" || w.id === "q~b"), "a row whose instant stands is not written")
  // A list that is not one move — stale, or naming a thread not on the shelf — is dealt the same way.
  const stale = consolePinPlacements(shelf, ["q~d", "nope", "p~c"])
  assert.deepEqual(apply(shelf, stale), ["q~d", "p~c", "p~a", "q~b", "p~e"], "listed rows lead; the unlisted keep their order after them")
})

// SNOOZED AND DONE, "By status"'s folded bands. Sessions shaped as a project board sees them: a wall-clock
// snooze parks a resting thread in Snoozed, and an archived one at rest is Done.
const session = (id: string, over: Partial<ThreadView> = {}): ThreadView =>
  ({ id, kind: "session", state: "open", runtime: "turn-idle", ...over }) as ThreadView
const later = "2099-01-01T00:00:00.000Z"
const archived = (id: string, archivedAt: string, over: Partial<ThreadView> = {}) => session(id, { state: "archived", archivedAt, ...over })

test("Snoozed holds every project's snoozed threads, most recently active first; a Console pin lifts one out and a board pin does not", () => {
  const threads = [
    session("a~resting"),
    session("a~old", { snoozedUntil: later, lastAssistantAt: "2026-10-01T00:00:00.000Z" }),
    session("b~new", { snoozedUntil: later, lastAssistantAt: "2026-10-03T00:00:00.000Z" }),
    session("b~board-pinned", { snoozedUntil: later, lastAssistantAt: "2026-10-02T00:00:00.000Z", pinnedAt: "2026-10-02T00:00:00.000Z" }),
    session("c~console-pinned", { snoozedUntil: later, consolePinnedAt: "2026-10-02T00:00:00.000Z" }),
    session("c~foreign", { snoozedUntil: later, foreign: true }),
  ]
  assert.deepEqual(consoleSnoozed(threads).map((x) => x.id), ["b~new", "b~board-pinned", "a~old"])
})

test("Done holds every project's finished threads, most recently finished first, and none still running", () => {
  const threads = [
    archived("a~1", "2026-10-01T00:00:00.000Z"),
    session("a~open"),
    archived("b~3", "2026-10-03T00:00:00.000Z"),
    // Archived but mid-turn: it spins in Running until it rests.
    archived("b~running", "2026-10-04T00:00:00.000Z", { runtime: "running" }),
    // Pinned on its board, so the partition keeps it live; this view ignores the board's pin.
    archived("c~board-pinned", "2026-10-02T00:00:00.000Z", { pinnedAt: "2026-10-02T00:00:00.000Z" }),
    // Settled, but on the Console's shelf: the Pinned band shows it instead.
    archived("c~console-pinned", "2026-10-05T00:00:00.000Z", { consolePinnedAt: "2026-10-05T00:00:00.000Z" }),
  ]
  assert.deepEqual(consoleDone(threads).map((x) => x.id), ["b~3", "c~board-pinned", "a~1"])
})

test("Done is the same list across deltas that leave every finished thread alone", () => {
  const settled = [archived("a~1", "2026-10-01T00:00:00.000Z"), archived("b~2", "2026-10-02T00:00:00.000Z")]
  const first = [...settled, session("a~open", { lastAssistantAt: "2026-10-01T00:00:00.000Z" })]
  const done = consoleDone(first)
  // A delta replaces the open thread's object: the board is a new array, its finished threads the same.
  const next = [...settled, session("a~open", { lastAssistantAt: "2026-10-02T00:00:00.000Z" })]
  assert.equal(consoleDone(next), done)
  assert.deepEqual(done.map((x) => x.id), ["b~2", "a~1"])
})
