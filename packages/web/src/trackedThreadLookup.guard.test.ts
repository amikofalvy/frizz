import assert from "node:assert/strict"
import { globSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"

// A COMPONENT THAT SHOWS ONE THREAD READS IT WITH useThreadSnapshot (hooks.ts has the why): looked up on
// the TRACKED board — `threadBySlug(useBoard(), slug)`, `threadBySlug(snap.board, slug)` — the read makes
// proxy-compare wrap the threads array, and wrapping each new one walks a descriptor per slot, ~0.5ms of
// every delta at 5,000 threads, paid by whichever render reaches it first. One such lookup anywhere in a
// render that a delta triggers brings the whole cost back, and nothing on screen shows it, so the lookups
// that remain are listed here with the reason each is not on that path.

const src = fileURLToPath(new URL("./", import.meta.url))
const ALLOWED = new Map([
  // The doc drawer's title, computed in a loop over the stack where a hook cannot go; only a doc drawer
  // (a session-less thread) reaches it.
  ["components/DrawerStack.tsx", 1],
  // The phone's ⋯ sheet, open only while the operator holds it.
  ["components/MobileThreadActionsSheet.tsx", 1],
  // The session-less thread's doc drawer.
  ["components/ThreadDrawer.tsx", 1],
  // transcriptStaleTime: handed the live board (`store.board`), not a tracked view of it.
  ["hooks.ts", 1],
])

test("no component looks a thread up on the tracked board, outside the listed few", () => {
  const found = new Map<string, number>()
  for (const file of globSync("**/*.{ts,tsx}", { cwd: src }).map((f) => f.split("\\").join("/"))) {
    if (/\.test\.tsx?$/.test(file) || /-fixture\.tsx$/.test(file) || file === "store.ts") continue
    const lines = readFileSync(`${src}/${file}`, "utf8").split("\n").filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
    const n = lines.filter((line) => /threadBySlug\(\s*(?:board\b|snap\.board|useSnapshot\()|resolveThreadRoute\(\s*(?:board|snap\.board)\b[^)]*threadBySlug/.test(line)).length
    if (n > 0) found.set(file, n)
  }
  assert.deepEqual([...found].sort(), [...ALLOWED].sort())
})
