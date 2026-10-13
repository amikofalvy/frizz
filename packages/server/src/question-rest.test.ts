// WHAT THE SERVER DOES ABOUT QUESTIONS ACROSS A THREAD'S RESTS — the real fold (applyRecord), the real
// scheduler and the real board over real SQLite, with the worker simulated rest by rest. The registrar's
// own grammar is pinned in question-fences.test.ts; this file pins how its corrections share a rest with
// the other wakes, and where a question that has FADED (asked at an earlier rest, never referenced since)
// leaves the thread.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Bus } from "./bus.ts"
import { createBoard } from "./board.ts"
import type { Project } from "./project.ts"
import { createScheduler } from "./scheduler.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { applyRecord, newTailState, type SessionTelemetry, type Tailer } from "./tailer.ts"

const at = (minute: number) => new Date(Date.parse("2026-10-20T10:00:00.000Z") + minute * 60_000).toISOString()
const fence = (info: string, body: string) => `\`\`\`${info}\n${body}\n\`\`\``
const choice = (id: string) => fence("question", `id: ${id}\nkind: choice\nquestion: SQLite or a JSON file?\noptions:\n  - label: SQLite\n  - label: JSON file`)
/** `kind: choice` with no options: refused by the registrar, so it draws a correction. */
const broken = (id: string) => fence("question", `id: ${id}\nkind: choice\nquestion: SQLite or a JSON file?`)

/** One thread, a simulated worker writing records through the real fold, and the scheduler and board
 *  reading what the fold produced. */
function world(over: Partial<SessionRow> = {}) {
  const slug = "t"
  const dir = mkdtempSync(join(tmpdir(), "frizz-question-rest-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession({
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-10-15T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  } as SessionRow)
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")
  const s = newTailState(slug, `sid-${slug}`, "/dev/null")
  const extra: Partial<SessionTelemetry> = {}
  const tele = (): SessionTelemetry => ({
    turn: "idle", permPrompt: false, subAgents: [], bgShells: [], retiredShells: [], retiredSubAgents: [],
    lastActivityAt: s.lastActivityAt, lastAssistantAt: s.lastAssistantAt, lastAssistant: s.lastAssistant,
    lastAssistantLine: s.lastAssistantLine, questionSightings: s.questionSightings, pendingQuestion: false,
    lastAssistantAllDone: s.lastAssistantAllDone, lastUserAt: s.lastUserAt, lastUserText: s.lastUserText,
    lastFence: s.lastFence, ...extra,
  } as SessionTelemetry)
  const tailer = {
    get: (x: string) => (x === slug ? tele() : undefined), foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  } as unknown as Tailer
  const sent: string[] = []
  let clock = Date.parse(at(0))
  const scheduler = createScheduler({
    wakeQuietWindowMs: 0, storage, fetchPr: async () => undefined, fetchGithubReview: async () => [],
    tailer, resume: async (_slug: string, message: string) => { sent.push(message) }, log: () => {}, now: () => clock,
  } as never)
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const board = createBoard(project, storage, new Bus(), tailer, "question-rest", { claudeBrokerDaemonAlive: () => true })
  return {
    storage, scheduler, board, sent, extra,
    /** Tick the scheduler with its clock at `minute`. */
    tick: async (minute: number) => { clock = Date.parse(at(minute)); await scheduler.tick() },
    user: (minute: number, text: string) => applyRecord(s, { type: "user", timestamp: at(minute), message: { role: "user", content: text } } as never),
    say: (minute: number, text: string) => applyRecord(s, { type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } } as never),
    deliveries: () => storage.db.prepare("SELECT fence_id FROM wake_delivery WHERE thread_slug = ? ORDER BY rowid").all(slug).map((r) => (r as { fence_id: string }).fence_id),
    view: () => board.refresh().threads.find((x) => x.id === slug)!,
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

// ── The corrective cap, beside an honoured park ─────────────────────────────────────────────────────

// A broken question fence and a VALID ```awaiting park in one message. SOURCE 14 counts its correction
// against PARK_BUMP_MAX; SOURCE 12 then finds the park honoured and handed the allowance back in the
// same tick — so the count never left zero, and a worker that rewrote the same broken fence on every
// rest was corrected on every rest, forever: the closed loop the cap exists to break (617 bumps to one
// thread on 2026-08-17).
test("a broken question fence beside an honoured park still runs out of corrections", async () => {
  const w = world()
  try {
    w.extra.bgShells = [{ label: "the suite", startedAt: at(0), state: "running", id: "toolu_x", taskId: "bzvt" }] as never
    w.user(0, "move the settings into a real store")
    for (let minute = 1; minute <= 8; minute++) {
      w.say(minute, `${broken("store")}\n\n${fence("awaiting", "status: working\nshells: [bzvt]\nfor: 1h")}`)
      await w.tick(minute + 0.25)
      // The delivered correction lands in the transcript as a user record, which closes the rest.
      w.user(minute + 0.5, w.sent[w.sent.length - 1] ?? "steer")
    }
    const corrections = w.deliveries().filter((id) => id.startsWith("park:question-fence:"))
    assert.equal(corrections.length, 3, `capped at PARK_BUMP_MAX — got ${corrections.length} corrections over eight identical rests`)
  } finally { w.close() }
})

test("an honoured park still gives the allowance back on a rest whose question fences all registered", async () => {
  const w = world()
  try {
    w.extra.bgShells = [{ label: "the suite", startedAt: at(0), state: "running", id: "toolu_x", taskId: "bzvt" }] as never
    w.user(0, "go")
    w.say(1, broken("store"))
    await w.tick(1.25)
    w.user(1.5, w.sent[0])
    assert.equal(w.storage.getSession("t")?.park_bumps, 1)
    // The negative control: the same honoured park with nothing to correct resets the count as before.
    w.say(2, fence("awaiting", "status: working\nshells: [bzvt]\nfor: 1h"))
    await w.tick(2.25)
    assert.equal(w.storage.getSession("t")?.park_bumps, 0)
  } finally { w.close() }
})

// ── One rest, one voice ──────────────────────────────────────────────────────────────────────────────

// A thread with a Goal armed at rest runs AUTONOMOUSLY: a non-secret question there is refused with
// "decide it yourself" (SOURCE 14). The Goal's own rest prompt fired on the same rest as well, and the
// outbox handed the worker both under "Frizz held 2 wakes" — the two-deliveries-for-one-rest shape the
// sign-off nudge already stands down for (SOURCE 9 reads the same correction), and the one an
// ```awaiting fence's own correction (SOURCE 12) holds the Goal for.
test("on a Goal thread, a refused question takes the rest: the Goal stands down for the correction", async () => {
  const w = world()
  try {
    w.storage.setRecurringPromptBySlug("t", { prompt: "Keep going until the suite is green.", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: at(0) })
    // The sign-off reminder off, so the bare rest below is the Goal's alone (it stands down for the
    // reminder, by design — see evalRestPrompts).
    w.storage.setSetting("signoffNudge", "off")
    w.user(0, "go")
    w.say(1, `One call to make first.\n\n${choice("store")}`)
    await w.tick(2)
    assert.deepEqual(w.storage.listThreadQuestions("t"), [], "autonomous: the question was not asked")
    assert.deepEqual(w.deliveries(), [`park:question-fence:${at(1)}`], "the correction alone — no Goal prompt beside it")
    assert.equal(w.sent.length, 1)
    assert.match(w.sent[0], /running autonomously, so the question was not asked/)
    // The worker decides, and rests bare: now the Goal has the rest to itself.
    w.user(2.5, w.sent[0])
    w.say(3, "Went with SQLite.")
    await w.tick(4)
    assert.ok(w.deliveries().some((id) => id.startsWith("stophook:")), "the next rest gets the Goal")
  } finally { w.close() }
})
