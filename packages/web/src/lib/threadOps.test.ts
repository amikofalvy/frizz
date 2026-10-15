import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView, ThreadWatchView } from "@frizz/shared"
import { queueOpsCounts } from "./queueOpsCounts.ts"
import { shellWatched, threadOps } from "./threadOps.ts"

// The rows the line of counts, its panels and the full-screen rail list come from one place, so one
// thread reads the same everywhere. The rule that had drifted: the rail left out an archived thread's
// watches and every watch no longer armed, and the line went on counting them.
const watch = (over: Partial<ThreadWatchView>) => ({ id: "w", kind: "github", subject: "pull", target: "acme/app#1", state: "armed", ...over }) as ThreadWatchView
const thread = (watches: ThreadWatchView[], state = "rested") =>
  ({ id: "t", state, subAgents: [], links: [], bgShells: [], watches }) as unknown as ThreadView
const counted = (t: ThreadView) => queueOpsCounts(t).map(({ key, n }) => ({ key, n }))

test("a watch is listed while it is armed and its thread is not archived — by every reader", () => {
  const watches = [
    watch({ id: "pr", target: "acme/app#391" }),
    watch({ id: "issue", subject: "issue", target: "acme/app#482" }),
    watch({ id: "timer", kind: "timer", target: "tmr_a" }),
    watch({ id: "fired", kind: "timer", target: "tmr_b", state: "fired" }),
    watch({ id: "done", target: "acme/app#7", state: "fired" }),
  ]
  const live = threadOps(thread(watches))
  assert.deepEqual([live.prs, live.issues, live.timers].map((rows) => rows.map((row) => row.id)), [["pr"], ["issue"], ["timer"]])
  assert.deepEqual(counted(thread(watches)), [{ key: "pr", n: 1 }, { key: "issue", n: 1 }, { key: "timer", n: 1 }])

  const archived = threadOps(thread(watches, "archived"))
  assert.deepEqual([archived.prs, archived.issues, archived.timers, archived.commands].map((rows) => rows.length), [0, 0, 0, 0], "an archived thread watches nothing")
  assert.deepEqual(counted(thread(watches, "archived")), [], "and the line counts nothing for it either")
})

test("a shell watch is a mark on the shell's own row, matched by task id, id or label", () => {
  const t = thread([watch({ kind: "shell", target: "bz7" }), watch({ kind: "shell", target: "Tail the build log" })])
  const watched = shellWatched(t)
  assert.equal(watched({ taskId: "bz7", label: "Run the dev server" }), true)
  assert.equal(watched({ id: "bz7", label: "Run the dev server" }), true)
  assert.equal(watched({ label: "Tail the build log" }), true)
  assert.equal(watched({ id: "other", label: "Run the tests" }), false)
  assert.equal(threadOps(t).shells.length, 0, "never a row of its own")
  assert.equal(shellWatched(thread(t.watches, "archived"))({ taskId: "bz7", label: "x" }), false, "an archived thread hears about nothing")
})
