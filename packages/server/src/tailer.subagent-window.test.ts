// THE WINDOW A SUB-AGENT RUNS IN — the denominator of the child drawer's context reading, which the
// child's transcript cannot supply (Claude names windows only on the parent session's `result`). A
// child on the thread's own model shares the thread's latched window; one on another model reads that
// model's billed row through the ingest; anything else is no reading at all.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage } from "./storage.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { createTailer } from "./tailer.ts"

const SESSION = "11111111-2222-3333-4444-666666666666"
const SLUG = "subagent-window"

function fixture(runtime: "broker" | null) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-subagent-window-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  // The parent's own record names its model exactly as its children's transcripts name theirs.
  writeFileSync(join(dir, `${SESSION}.jsonl`), `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-14T18:24:00.000Z",
    message: { id: "m1", model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 4, cache_read_input_tokens: 120_000 } },
  })}\n`)
  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `frizz-${SLUG}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: SLUG, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(SLUG, "claude")
  if (runtime) storage.setClaudeRuntime(SLUG, runtime)
  const asked: { sessionId: string; model: string }[] = []
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage, bus: new Bus(), sessionLogDir: dir,
    onChange: () => {}, paneDead: () => false,
    runtimeContextWindow: () => 500_000,
    runtimeModelContextWindow: (sessionId, model) => {
      asked.push({ sessionId, model })
      return model === "claude-haiku-4-5-20251001" ? 200_000 : undefined
    },
  })
  tailer.tick()
  return {
    tailer, asked,
    cleanup: () => { tailer.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test("a child on the thread's model shares its window; another model reads its billed row", () => {
  const f = fixture("broker")
  try {
    assert.equal(f.tailer.get(SLUG)?.contextWindow, 500_000, "precondition: the thread's own window latched")
    assert.equal(f.tailer.subAgentContextWindow?.(SLUG, "claude-opus-5-5"), 500_000)
    assert.deepEqual(f.asked, [], "the thread's own latched window answers without asking the ingest")
    assert.equal(f.tailer.subAgentContextWindow?.(SLUG, "claude-haiku-4-5-20251001"), 200_000)
    assert.deepEqual(f.asked, [{ sessionId: SESSION, model: "claude-haiku-4-5-20251001" }])
    assert.equal(f.tailer.subAgentContextWindow?.(SLUG, "claude-sonnet-5-5"), undefined, "nothing billed ⇒ no window")
    assert.equal(f.tailer.subAgentContextWindow?.("not-a-thread", "claude-opus-5-5"), undefined)
  } finally {
    f.cleanup()
  }
})

test("a thread with no broker has no SDK report to read a child's window from", () => {
  const f = fixture(null)
  try {
    assert.equal(f.tailer.subAgentContextWindow?.(SLUG, "claude-haiku-4-5-20251001"), undefined)
    assert.deepEqual(f.asked, [])
  } finally {
    f.cleanup()
  }
})
