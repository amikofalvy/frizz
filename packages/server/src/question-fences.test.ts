// THE QUESTION REGISTRAR against real SQLite: a ```question fence a worker writes becomes a
// `thread_question` row once, for the life of its thread, and every way that could go wrong is refused by
// name rather than minting a second row or silently dropping the ask.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot, Settings } from "@frizz/shared"
import type { QuestionSighting } from "./backend/types.ts"
import type { BoardManager } from "./board.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import { createQuestionRegistrar, QUESTION_FENCES_REGISTER_FROM, questionFenceCorrection, standingQuestions, syncQuestionFences } from "./question-fences.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { Tailer } from "./tailer.ts"

const fence = (body: string) => `\`\`\`question\n${body}\n\`\`\``
const choice = (id: string, question = "SQLite or a JSON file?") =>
  fence(`id: ${id}\nkind: choice\nquestion: ${question}\noptions:\n  - label: SQLite\n    recommended: true\n  - label: JSON file`)
// After QUESTION_FENCES_REGISTER_FROM, so every sighting here is one the registrar reads.
const at = (minute: number) => new Date(Date.parse("2026-10-20T10:00:00.000Z") + minute * 60_000).toISOString()

function storageHarness() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-question-fences-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  return { dir, storage, close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-10-01T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

const sync = (storage: ReturnType<typeof createStorage>, sightings: QuestionSighting[], over: { spawnedAt?: string; autonomousGoal?: string } = {}) =>
  syncQuestionFences(storage, { slug: "t", spawnedAt: over.spawnedAt ?? "2026-10-01T00:00:00.000Z", sightings, autonomousGoal: over.autonomousGoal })

test("a new id registers ONE row, at the message's own instant, and replaying the message is a no-op", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const sightings = [{ at: at(0), text: choice("settings-store") }]
    const first = sync(h.storage, sightings)
    assert.deepEqual(first.faults, [])
    assert.equal(first.registered.length, 1)
    const [q] = h.storage.listThreadQuestions("t")
    assert.equal(q.handle, "settings-store")
    assert.equal(q.asked_at, Date.parse(at(0)), "asked_at is the message's instant, which places the card at that rest")
    assert.equal(JSON.parse(q.spec).question, "SQLite or a JSON file?")
    // A refold after a restart, a second tick, the worker restating its fence: all the same no-op.
    const again = sync(h.storage, [...sightings, { at: at(5), text: choice("settings-store") }])
    assert.deepEqual(again.registered, [])
    assert.deepEqual(again.faults, [])
    assert.equal(h.storage.listThreadQuestions("t").length, 1)
    assert.deepEqual(again.refs.map((r) => r.at), [at(0), at(5)], "a restatement places the card like a reference")
  } finally { h.close() }
})

test("a spent id is refused for a different question, and for the same question asked again after it settled", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    sync(h.storage, [{ at: at(0), text: choice("settings-store") }])
    const clash = sync(h.storage, [{ at: at(0), text: choice("settings-store") }, { at: at(1), text: choice("settings-store", "Postgres?") }])
    assert.match(clash.faults[0].faults[0], /already used by a different question/)
    const [q] = h.storage.listThreadQuestions("t")
    h.storage.answerThreadQuestion(q.id, JSON.stringify({ questionId: q.id, question: "SQLite or a JSON file?", chosen: ["SQLite"] }), Date.parse(at(2)))
    const reask = sync(h.storage, [{ at: at(0), text: choice("settings-store") }, { at: at(3), text: choice("settings-store") }])
    assert.equal(reask.faults.length, 1)
    assert.match(reask.faults[0].faults[0], /already asked and answered — an id is never reused/)
    assert.equal(h.storage.listThreadQuestions("t").length, 1, "nothing re-opened the answered question")
  } finally { h.close() }
})

test("a follow-up's id is spent with its tree, and resolves to the root it rides in", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const parent = choice("settings-store")
    const child = fence("id: sqlite-path\nkind: text\nwhen: settings-store = SQLite\nquestion: Where should it live?")
    const out = sync(h.storage, [{ at: at(0), text: `${parent}\n\n${child}` }])
    assert.equal(out.registered.length, 1)
    const reuse = sync(h.storage, [{ at: at(0), text: `${parent}\n\n${child}` }, { at: at(1), text: fence("id: sqlite-path\nkind: text\nquestion: Something else?") }])
    assert.match(reuse.faults[0].faults[0], /`id: sqlite-path` is already used/)
    const ref = sync(h.storage, [{ at: at(2), text: fence("id: sqlite-path") }])
    assert.deepEqual(ref.refs.map((r) => r.rowId), [out.registered[0].id])
  } finally { h.close() }
})

test("a reference to an unknown or settled id is refused; a legacy thread and an old message register nothing", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const unknown = sync(h.storage, [{ at: at(0), text: fence("id: never-asked") }])
    assert.match(unknown.faults[0].faults[0], /no question of yours uses that id/)
    const invalid = sync(h.storage, [{ at: at(0), text: fence("kind: text\nquestion: Q?") }])
    assert.match(invalid.faults[0].faults[0], /no `id:`/)
    // Dispatched before the free-form fence was retired: there a body fence IS the legacy ask.
    assert.deepEqual(sync(h.storage, [{ at: at(0), text: choice("x") }], { spawnedAt: "2026-09-01T00:00:00.000Z" }), { registered: [], faults: [], refs: [] })
    // Written before the registrar existed: prose then, and prose now.
    const before = new Date(Date.parse(QUESTION_FENCES_REGISTER_FROM) - 1).toISOString()
    assert.deepEqual(sync(h.storage, [{ at: before, text: choice("x") }]), { registered: [], faults: [], refs: [] })
    assert.equal(h.storage.listThreadQuestions("t").length, 0)
  } finally { h.close() }
})

test("an autonomous thread's question is refused with its Goal; a secret still registers", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const goal = "Keep going until the suite is green."
    const out = sync(h.storage, [{ at: at(0), text: `${choice("pick")}\n\n${fence("id: otp\nkind: secret\nquestion: The npm one-time code")}` }], { autonomousGoal: goal })
    assert.deepEqual(out.registered.map((q) => q.handle), ["otp"])
    assert.match(out.faults[0].faults[0], /running autonomously/)
    assert.match(out.faults[0].faults[0], /Keep going until the suite is green/)
  } finally { h.close() }
})

test("a question stands at the rest that asked it and at a rest that references it — an older one fades", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    sync(h.storage, [{ at: at(0), text: choice("old-one") }, { at: at(10), text: choice("new-one") }])
    const rows = h.storage.listThreadQuestions("t")
    // The human spoke at minute 5: old-one was asked at an earlier rest, new-one at this one.
    const tele = { lastUserAt: at(5), questionSightings: [{ at: at(10), text: choice("new-one") }] }
    assert.deepEqual(standingQuestions(rows, tele).map((q) => q.handle), ["new-one"])
    // A reference at this rest brings the old one back to it.
    const referenced = { ...tele, questionSightings: [...tele.questionSightings, { at: at(11), text: fence("id: old-one") }] }
    assert.deepEqual(standingQuestions(rows, referenced).map((q) => q.handle).sort(), ["new-one", "old-one"])
    // A worker on the older contract claims it with `questions:` — still read.
    const claimed = { ...tele, lastFence: { kind: "awaiting" as const, hints: [{ kind: "question" as const, value: rows[0].id }] } }
    assert.deepEqual(standingQuestions(rows, claimed as never).map((q) => q.handle).sort(), ["new-one", "old-one"])
    // Answered is never standing.
    h.storage.answerThreadQuestion(rows[1].id, "{}", Date.parse(at(12)))
    assert.deepEqual(standingQuestions(h.storage.listThreadQuestions("t"), referenced).map((q) => q.handle), ["old-one"])
  } finally { h.close() }
})

test("the registrar sweep reads only threads whose sightings moved, and skips archived threads", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.upsertSession(row("gone", { state: "archived", archived: 1 }))
    const sightings: Record<string, QuestionSighting[]> = { t: [{ at: at(0), text: choice("a") }], gone: [{ at: at(0), text: choice("b") }] }
    const registrar = createQuestionRegistrar({ storage: h.storage, tailer: { get: (slug) => ({ questionSightings: sightings[slug] }) } })
    assert.equal(registrar.sweep(), true)
    assert.equal(registrar.sweep(), false, "nothing moved, nothing read")
    sightings.t = [...sightings.t, { at: at(1), text: choice("c") }]
    assert.equal(registrar.sweep(), true)
    assert.deepEqual(h.storage.listThreadQuestions("t").map((q) => q.handle), ["a", "c"])
    assert.deepEqual(h.storage.listThreadQuestions("gone"), [])
  } finally { h.close() }
})

test("the correction names every fault under the fold-out lead", () => {
  const text = questionFenceCorrection([{ at: at(0), id: "x", faults: ["no `kind:`"] }, { at: at(0), faults: ["no `id:`"] }])
  assert.match(text, /^⚠️ Your ```question fence could not register, so the human has NOT been asked:/)
  assert.match(text, /- `x` — no `kind:`/)
  assert.match(text, /- no `id:`/)
})

// ── At the RPC boundary: `unask` and `done` see the newest fence, by the worker's own id ──────────────

function routerHarness(sightings: { current: QuestionSighting[] }) {
  const h = storageHarness()
  const project: Project = { dir: h.dir, id: "qf", name: "test", label: "test", stateDir: h.dir, cwdSlug: "test" }
  const snapshot: BoardSnapshot = { projectDir: h.dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  const board: BoardManager = {
    snapshot: async () => snapshot, currentSeq: () => 0, rebuild: async () => snapshot,
    refresh: () => snapshot, start: async () => {}, stop: async () => {},
  }
  let ticks = 0
  const tailer: Tailer = {
    get: () => ({ questionSightings: sightings.current }) as never, foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => { ticks++ },
  }
  const scheduler = { start: () => {}, stop: async () => {}, tick: async () => {}, kick: () => {} }
  const ctx = { project, storage: h.storage, board, tailer, scheduler, getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings } as unknown as AppContext
  return { ...h, router: createRouter(ctx), ticks: () => ticks }
}

test("done refuses on a question fenced in the same message, naming it by the worker's own id", async () => {
  const sightings = { current: [{ at: at(0), text: choice("settings-store") }] }
  const h = routerHarness(sightings)
  try {
    h.storage.upsertSession(row("t"))
    // Nothing has registered yet — the registrar's own clock has not come round. `done` must not wait for it.
    assert.equal(h.storage.listThreadQuestions("t").length, 0)
    const result = await h.router.markOwnDone.handler({ input: { slug: "t", body: "- Shipped." } })
    assert.equal(result.done, false)
    assert.deepEqual(result.blockingQuestions, [{ id: "settings-store", question: "SQLite or a JSON file?" }])
    assert.ok(h.ticks() > 0, "the tailer was caught up first")
  } finally { h.close() }
})

test("unask takes the worker's own id — a follow-up's resolves to its root — and a legacy qst_ id still works", async () => {
  const sightings = { current: [{ at: at(0), text: `${choice("settings-store")}\n\n${fence("id: sqlite-path\nkind: text\nwhen: settings-store = SQLite\nquestion: Where?")}` }] }
  const h = routerHarness(sightings)
  try {
    h.storage.upsertSession(row("t"))
    const out = await h.router.unask.handler({ input: { slug: "t", id: "sqlite-path" } })
    assert.equal(out.withdrawn, true)
    assert.equal(h.storage.listThreadQuestions("t")[0].state, "withdrawn")
    const legacy = h.storage.askThreadQuestion({ id: "qst_aaaaaaaaaaaa", slug: "t", spec: JSON.stringify({ question: "Q?", kind: "question" }), askedAtMs: 1 })
    assert.equal((await h.router.unask.handler({ input: { slug: "t", id: legacy.id } })).withdrawn, true)
    assert.equal((await h.router.unask.handler({ input: { slug: "t", id: "no-such-id" } })).withdrawn, false)
  } finally { h.close() }
})

// ── The fold: which messages the registrar gets to read ───────────────────────────────────────────────

test("the fold notes every assistant message carrying a fence — mid-turn too — and never a child's or a quoted one", async () => {
  const { applyRecord, applyEvent, newTailState } = await import("./tailer.ts")
  const s = newTailState("t", "sid-t", "/dev/null")
  const assistant = (timestamp: string, text: string, extra: object = {}) => applyRecord(s, {
    type: "assistant", timestamp, ...extra,
    message: { role: "assistant", content: [{ type: "text", text }], stop_reason: null },
  } as never)
  assistant(at(0), `Before I go on:\n\n${choice("a")}\n\nNow running the build.`)
  assistant(at(1), "No fence here.")
  assistant(at(2), `A child's report:\n\n${choice("child")}`, { isSidechain: true })
  assistant(at(3), `Quoting the grammar:\n\n\`\`\`\`md\n${choice("quoted")}\n\`\`\`\``)
  // A human turn does not clear them: a fence registers a ROW, whatever was said after it.
  applyRecord(s, { type: "user", timestamp: at(4), message: { role: "user", content: "thanks" } } as never)
  assert.deepEqual(s.questionSightings?.map((x) => x.at), [at(0)])
  assert.equal(s.questionSightings?.[0].text, choice("a"), "only the fence is kept, not the prose around it")
  // The normalized (codex) fold: a commentary block asks too, and the final answer echoed on the turn's
  // closing bracket is noted once.
  const c = newTailState("c", "sid-c", "/dev/null")
  applyEvent(c, { kind: "assistant-text", text: choice("mid"), final: false, at: at(0) } as never)
  applyEvent(c, { kind: "assistant-text", text: choice("end"), final: true, at: at(1) } as never)
  applyEvent(c, { kind: "turn-end", finalText: choice("end"), at: at(1) } as never)
  assert.deepEqual(c.questionSightings?.map((x) => x.at), [at(0), at(1)])
})

test("restating a question without its follow-up places the card — it is still the same question", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const parent = choice("settings-store")
    const child = fence("id: sqlite-path\nkind: text\nwhen: settings-store = SQLite\nquestion: Where should it live?")
    const asked = { at: at(0), text: `${parent}\n\n${child}` }
    const out = sync(h.storage, [asked, { at: at(5), text: parent }])
    assert.deepEqual(out.faults, [])
    assert.equal(out.registered.length, 1)
    assert.deepEqual(out.refs.map((r) => r.at), [at(5)], "the restatement is a reference to the registered tree")
  } finally { h.close() }
})
