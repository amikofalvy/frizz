// THE QUESTION REGISTRAR against real SQLite: a ```question fence a worker writes becomes a
// `thread_question` row once, for the life of its thread, and every way that could go wrong is refused by
// name rather than minting a second row or silently dropping the ask.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { questionFenceBlocks, questionHandles, type AskedQuestion, type BoardSnapshot, type Settings } from "@frizz/shared"
import type { QuestionSighting } from "./backend/types.ts"
import type { BoardManager } from "./board.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import { createQuestionFaultBook, createQuestionRegistrar, QUESTION_FENCES_REGISTER_FROM, questionFenceCorrection, standingQuestions, syncQuestionFences } from "./question-fences.ts"
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
    assert.deepEqual(sync(h.storage, [{ at: at(0), text: choice("x") }], { spawnedAt: "2026-09-01T00:00:00.000Z" }), { registered: [], cancelled: [], attached: [], faults: [], refs: [] })
    // Written before the registrar existed: prose then, and prose now.
    const before = new Date(Date.parse(QUESTION_FENCES_REGISTER_FROM) - 1).toISOString()
    assert.deepEqual(sync(h.storage, [{ at: before, text: choice("x") }]), { registered: [], cancelled: [], attached: [], faults: [], refs: [] })
    assert.equal(h.storage.listThreadQuestions("t").length, 0)
  } finally { h.close() }
})

test("an autonomous thread's question is recorded and cancelled at once; a secret still registers", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const goal = "Keep going until the suite is green."
    const sightings = [{ at: at(0), text: `${choice("pick")}\n\n${fence("id: otp\nkind: secret\nquestion: The npm one-time code")}` }]
    const out = sync(h.storage, sightings, { autonomousGoal: goal })
    assert.deepEqual(out.registered.map((q) => q.handle), ["otp"])
    assert.deepEqual(out.cancelled.map((q) => q.handle), ["pick"])
    assert.deepEqual(out.faults, [], "the worker hears of it from the cancellation wake, not a fence correction")
    // The row is the record: dismissed and still owed to the worker, which is what the scheduler's
    // cancellation wake reads (evalQuestionAnswers) — and never open, so it never reaches the human.
    const pick = h.storage.listThreadQuestions("t").find((q) => q.handle === "pick")!
    assert.equal(pick.state, "dismissed")
    assert.equal(pick.asked_at, Date.parse(at(0)))
    assert.deepEqual(h.storage.listThreadQuestions("t", { openOnly: true }).map((q) => q.handle), ["otp"])
    // THE GOAL IS DISARMED. The same message read again must not turn the refused fence into a question:
    // the worker was told to decide it and did. (Control: without the row this registered `pick`.)
    for (const replay of [sync(h.storage, sightings, { autonomousGoal: goal }), sync(h.storage, sightings)]) {
      assert.deepEqual(replay.registered, [])
      assert.deepEqual(replay.cancelled, [])
      assert.deepEqual(replay.faults, [])
    }
    assert.deepEqual(h.storage.listThreadQuestions("t", { openOnly: true }).map((q) => q.handle), ["otp"])
    // Asked again under the same id once the thread takes questions: the id is spent, and it says so.
    const again = sync(h.storage, [...sightings, { at: at(5), text: choice("pick") }])
    assert.match(again.faults[0].faults[0], /`pick` was already asked and dismissed.*an id is never reused/)
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

// ── What a sync REFUSED, kept for the board ──────────────────────────────────────────────────────────
//
// A refused fence has no row, and neither does one the registrar has not reached yet, so the web could not
// tell them apart: a fence reusing a spent id drew as a question for good (and moved the old question's
// card under itself). Every sync records its faults in one book, which the board reads.

test("every sync records what it refused in the one book, whichever caller ran it — and the whole ring, not one rest", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const book = createQuestionFaultBook()
    const sightings: QuestionSighting[] = [
      { at: at(0), text: choice("store") },
      // A later rest: the SAME id on a different question (refused), and a reference to nothing (refused).
      { at: at(5), text: `${choice("store", "Which region?")}\n\n${fence("id: ghost")}` },
      // …and a rest after that which is fine, so the faults above are no longer "the current rest's".
      { at: at(9), text: choice("later") },
    ]
    const registrar = createQuestionRegistrar({ storage: h.storage, tailer: { get: () => ({ questionSightings: sightings }) }, faultBook: book })
    registrar.sweep()
    const faults = book.of("t") ?? []
    assert.deepEqual(faults.map((f) => [f.at, f.id]), [[at(5), "store"], [at(5), "ghost"]], "both refusals, each at its own message's instant")
    assert.match(faults[0].faults[0], /already used by a different question/)
    assert.match(faults[1].faults[0], /alone references a question/)
    assert.deepEqual(h.storage.listThreadQuestions("t").map((q) => q.handle), ["store", "later"])

    // The scheduler's pass (and the router's catch-up) run the same function over the same book, so a
    // second caller rewrites the entry with the same reading — never a second, different list.
    const other = syncQuestionFences(h.storage, { slug: "t", spawnedAt: "2026-10-01T00:00:00.000Z", sightings, faultBook: book })
    assert.deepEqual(book.of("t"), other.faults)
    assert.deepEqual(other.faults.map((f) => f.id), ["store", "ghost"])

    // The worker fixes one: `ghost` asked properly in a later message. That fault is no longer news to the
    // scheduler (heldAt), so it leaves the book in the same pass; the reused id is still refused.
    sightings.push({ at: at(12), text: choice("ghost", "Is the ghost real?") })
    registrar.sweep()
    assert.deepEqual((book.of("t") ?? []).map((f) => f.id), ["store"])
  } finally { h.close() }
})

test("a sync that refuses nothing forgets the thread, and a thread with no fence left is forgotten too", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const book = createQuestionFaultBook()
    let sightings: QuestionSighting[] = [{ at: at(0), text: fence("id: ghost") }]
    const registrar = createQuestionRegistrar({ storage: h.storage, tailer: { get: () => ({ questionSightings: sightings }) }, faultBook: book })
    registrar.sweep()
    assert.equal(book.of("t")?.length, 1)
    sightings = [{ at: at(0), text: fence("id: ghost") }, { at: at(1), text: choice("ghost") }]
    registrar.sweep()
    assert.equal(book.of("t"), undefined, "the reference now names a question that held")

    sightings = [{ at: at(0), text: fence("id: nothing") }]
    registrar.sweep()
    assert.equal(book.of("t")?.length, 1)
    sightings = []
    registrar.sweep()
    assert.equal(book.of("t"), undefined, "a new session: no fence in the fold, so nothing refused on screen")
  } finally { h.close() }
})

test("the scheduler's pass writes the same book, so the board shows exactly the refusal the worker is corrected for", async () => {
  const { createScheduler } = await import("./scheduler.ts")
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const book = createQuestionFaultBook()
    const sightings: QuestionSighting[] = [{ at: at(0), text: choice("store") }, { at: at(5), text: choice("store", "Which region?") }]
    const s = createScheduler({
      wakeQuietWindowMs: 0, storage: h.storage, fetchPr: async () => undefined, fetchGithubReview: async () => [], questionFaults: book,
      tailer: { get: () => ({ turn: "idle", lastAssistantAt: at(5), lastActivityAt: at(5), subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false, questionSightings: sightings }) } as never,
      resume: async () => {}, log: () => {},
    })
    await s.tick()
    assert.deepEqual((book.of("t") ?? []).map((f) => [f.at, f.id]), [[at(5), "store"]])
    const wakes = (h.storage.db.prepare("SELECT message FROM wake_delivery WHERE thread_slug = 't'").all() as { message: string }[]).map((w) => w.message)
    const correction = wakes.find((m) => /could not register/.test(m))
    assert.ok(correction, `the worker is corrected for it (got: ${JSON.stringify(wakes)})`)
    assert.ok(correction.includes(book.of("t")![0].faults[0]), "in the words the board carries")
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
    snapshot: async () => snapshot, currentSeq: () => 0, deltasSince: () => null, snapshotState: async () => ({ board: ({}) as never, seq: 0 }), rebuild: async () => snapshot,
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

test("unask takes the worker's own id — never a follow-up's, which names its root instead — and a legacy qst_ id still works", async () => {
  const sightings = { current: [{ at: at(0), text: `${choice("settings-store")}\n\n${fence("id: sqlite-path\nkind: text\nwhen: settings-store = SQLite\nquestion: Where?")}` }] }
  const h = routerHarness(sightings)
  try {
    h.storage.upsertSession(row("t"))
    const viaFollowUp = await h.router.unask.handler({ input: { slug: "t", id: "sqlite-path" } })
    assert.equal(viaFollowUp.withdrawn, false)
    assert.equal(viaFollowUp.id, "settings-store")
    assert.equal(h.storage.listThreadQuestions("t")[0].state, "open")
    const out = await h.router.unask.handler({ input: { slug: "t", id: "settings-store" } })
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

// ── SOURCE 14: the correction for a fence that could not register ─────────────────────────────────────

async function correctionHarness(sightings: QuestionSighting[], tele: { lastUserAt?: string; lastAssistantAt?: string; turn?: string } = {}) {
  const { createScheduler } = await import("./scheduler.ts")
  const h = storageHarness()
  h.storage.upsertSession(row("t"))
  const sent: string[] = []
  const restedAt = tele.lastAssistantAt ?? sightings[sightings.length - 1]?.at ?? at(0)
  const s = createScheduler({
    wakeQuietWindowMs: 0,
    storage: h.storage,
    fetchPr: async () => undefined,
    fetchGithubReview: async () => [],
    tailer: {
      get: () => ({
        turn: tele.turn ?? "idle", lastAssistantAt: restedAt, lastActivityAt: restedAt, lastUserAt: tele.lastUserAt,
        subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false, questionSightings: sightings,
      }),
    } as never,
    resume: async (_slug, message) => { sent.push(message) },
    log: () => {},
  })
  const queued = () => h.storage.db.prepare("SELECT fence_id, message FROM wake_delivery WHERE thread_slug = 't'").all() as { fence_id: string; message: string }[]
  return { ...h, s, sent, queued }
}

test("a fence that could not register is corrected at rest, once, and the sign-off nudge stands down for it", async () => {
  const h = await correctionHarness([{ at: at(1), text: fence("id: settings-store\nkind: choice\nquestion: SQLite?") }])
  try {
    await h.s.tick()
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1, "one correction, and no 'rested without a fence' beside it")
    assert.equal(rows[0].fence_id, `park:question-fence:${at(1)}`)
    assert.match(rows[0].message, /^⚠️ Your ```question fence could not register/)
    assert.match(rows[0].message, /`settings-store` — `kind: choice` needs two or more options/)
    assert.equal(h.sent.length, 1, "and it reached the worker")
    assert.equal(h.storage.getSession("t")?.park_bumps, 1, "counted against the corrective cap")
  } finally { h.close() }
})

test("no correction mid-turn, none for an older rest's fence, and none once the same id registered later in the rest", async () => {
  const bad = { at: at(1), text: fence("id: settings-store\nkind: choice\nquestion: SQLite?") }
  const midTurn = await correctionHarness([bad], { turn: "in-flight" })
  try {
    await midTurn.s.tick()
    assert.deepEqual(midTurn.queued(), [])
  } finally { midTurn.close() }
  const olderRest = await correctionHarness([bad], { lastUserAt: at(2), lastAssistantAt: at(3) })
  try {
    await olderRest.s.tick()
    assert.deepEqual(olderRest.queued().filter((r) => r.fence_id.startsWith("park:")), [], "the human spoke since; that rest is over")
  } finally { olderRest.close() }
  const fixed = await correctionHarness([bad, { at: at(2), text: choice("settings-store") }])
  try {
    await fixed.s.tick()
    assert.deepEqual(fixed.queued(), [], "the worker fixed it in the same rest; the registered question signs the rest off")
    assert.equal(fixed.storage.listThreadQuestions("t").length, 1)
  } finally { fixed.close() }
})

// ── A follow-up that arrives LATER (2026-10-13) ───────────────────────────────────────────────────────
//
// Found with real model replies: a `when:` follow-up that failed once could never be asked. Its parent
// had registered, so the retry — the follow-up alone, beside a reference to its parent, or under a
// restatement of it — never had "its parent in the same message", and the third shape vanished without a
// fault. A follow-up may now attach while its parent is still open. The texts are the models' own.

const PREFS_STORE = [
  "```question", "id: prefs-store", "kind: choice",
  "question: Should user preferences persist in SQLite or in the main Postgres database?",
  "options:",
  "  - label: SQLite (better-sqlite3)",
  "    description: no network hop on reads, same driver as sessions; not in the nightly backup",
  "    recommended: true",
  "  - label: Postgres",
  "    description: backed up nightly; ~3ms round trip on every prefs read",
  "---",
  "Preferences are read on every request (theme, locale, feature flags) and written only from the settings page.",
  "```",
].join("\n")
const prefsPath = (when: string, extra = "") => [
  "```question", "id: prefs-sqlite-path", "kind: choice", `when: ${when}`,
  "question: Where should the SQLite preferences file live?",
  "options:",
  "  - label: Beside `data/sessions.db`",
  "    description: one directory to back up and mount",
  "    recommended: true",
  "  - label: Its own `data/prefs.db`",
  "    description: can be moved or wiped without touching sessions",
  ...(extra ? ["---", extra] : []),
  "```",
].join("\n")
const FIRST_TRY = `The store is your call, so here it is first; nothing is written yet.\n\n${PREFS_STORE}\n\n${prefsPath("prefs-store = SQLite")}`
const RIGHT_LABEL = "prefs-store = SQLite (better-sqlite3)"
const RETRIES: Record<string, string> = {
  "the follow-up alone": `The first question is still waiting.\n\n${prefsPath(RIGHT_LABEL, "This only applies if SQLite is chosen for preferences. Postgres needs no file path.")}`,
  "a reference to the parent, then the follow-up": `Here is the corrected follow-up.\n\n${fence("id: prefs-store")}\n\n${prefsPath(RIGHT_LABEL)}`,
  "the parent restated, then the follow-up": `The store is your call, so here it is first; nothing is written yet.\n\n${PREFS_STORE}\n\n${prefsPath(RIGHT_LABEL)}`,
}

/** EVERY FENCE IN A MESSAGE IS ACCOUNTED FOR: it registered, attached, referenced a row, or was refused
 *  by id. Returns the ids of the fences that were none of those — which must be empty. */
function unaccounted(storage: ReturnType<typeof createStorage>, out: ReturnType<typeof sync>, sighting: QuestionSighting): string[] {
  const rows = new Map(storage.listThreadQuestions("t").map((q) => [q.id, q]))
  const handlesOf = (rowId: string) => questionHandles(JSON.parse(rows.get(rowId)!.spec))
  const here = <T extends { at: string }>(xs: T[]) => xs.filter((x) => x.at === sighting.at)
  const named = new Set<string>([
    ...[...out.registered, ...out.cancelled].filter((q) => q.asked_at === Date.parse(sighting.at)).flatMap((q) => handlesOf(q.id)),
    ...here(out.attached).flatMap((a) => a.handles),
    ...here(out.refs).flatMap((r) => handlesOf(r.rowId)),
    ...here(out.faults).flatMap((f) => (f.id ? [f.id] : [])),
  ])
  const anonymousFaults = here(out.faults).filter((f) => !f.id).length
  const missing: string[] = []
  let anonymous = 0
  for (const b of questionFenceBlocks(sighting.text)) {
    if (b.read.id === undefined) anonymous++
    else if (!named.has(b.read.id)) missing.push(b.read.id)
  }
  return anonymous > anonymousFaults ? [...missing, "(a fence with no id)"] : missing
}

test("a follow-up whose first `when:` named the wrong label is told the real labels — and every retry shape then attaches", () => {
  for (const [shape, retry] of Object.entries(RETRIES)) {
    const h = storageHarness()
    try {
      h.storage.upsertSession(row("t"))
      const first = { at: at(0), text: FIRST_TRY }
      const asked = sync(h.storage, [first])
      assert.deepEqual(asked.registered.map((q) => q.handle), ["prefs-store"], "the parent stands on its own")
      assert.deepEqual(asked.faults, [{
        at: at(0), id: "prefs-sqlite-path",
        faults: ["`when:` names the option `SQLite`, and `prefs-store` has only `SQLite (better-sqlite3)`, `Postgres` — write the label exactly as the option has it"],
      }])
      assert.deepEqual(unaccounted(h.storage, asked, first), [])

      const second = { at: at(5), text: retry }
      const out = sync(h.storage, [first, second])
      assert.deepEqual(out.faults, [], `${shape}: nothing is refused — and the first try's fault is fixed, so it is no longer news`)
      assert.deepEqual(out.registered, [], `${shape}: no second row`)
      const [q] = h.storage.listThreadQuestions("t")
      assert.deepEqual(out.attached, [{ at: at(5), rowId: q.id, handles: ["prefs-sqlite-path"] }], shape)
      const spec = JSON.parse(q.spec) as AskedQuestion
      assert.equal(spec.options?.[0].followUps?.[0].handle, "prefs-sqlite-path", `${shape}: it hangs under the option it names`)
      assert.equal(spec.options?.[0].followUps?.[0].options?.length, 2)
      assert.equal(q.asked_at, Date.parse(at(0)), `${shape}: the parent's own instant has not moved`)
      assert.ok(out.refs.some((r) => r.at === at(5) && r.rowId === q.id), `${shape}: the parent is referenced by the message that grew it`)
      assert.deepEqual(unaccounted(h.storage, out, second), [], shape)
      // …so it stands at that rest, though a human turn has passed since it was asked.
      assert.deepEqual(standingQuestions(h.storage.listThreadQuestions("t"), { lastUserAt: at(2), questionSightings: [first, second] }).map((x) => x.handle), ["prefs-store"], shape)

      // REPLAYED — a refold after a restart, the scheduler's next tick: nothing new, nothing moved.
      const before = JSON.stringify(h.storage.listThreadQuestions("t"))
      const again = sync(h.storage, [first, second])
      assert.deepEqual([again.registered, again.attached, again.faults], [[], [], []], `${shape}: replay`)
      assert.equal(JSON.stringify(h.storage.listThreadQuestions("t")), before, `${shape}: replay wrote nothing`)
      // …and still nothing once the human has answered the tree.
      h.storage.answerThreadQuestion(q.id, JSON.stringify({ questionId: q.id, question: spec.question, chosen: ["Postgres"] }), Date.parse(at(9)))
      const settled = sync(h.storage, [first, second])
      assert.deepEqual([settled.registered, settled.attached, settled.faults], [[], [], []], `${shape}: replay after the answer`)
    } finally { h.close() }
  }
})

test("a late follow-up that cannot attach is refused by name, with the way out", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const followUp = (id: string, when: string, body = "kind: text\nquestion: And then?") => fence(`id: ${id}\n${body.replace(/^(kind: \w+)/, `$1\nwhen: ${when}`)}`)
    const multi = fence("id: targets\nkind: multi\nquestion: Which packages?\noptions:\n  - auth\n  - billing")
    const text = fence("id: scope\nkind: text\nquestion: Which npm scope?")
    sync(h.storage, [{ at: at(0), text: [choice("answered"), choice("withdrawn", "W?"), choice("dismissed", "D?"), choice("open", "O?"), multi, text].join("\n\n") }])
    const byHandle = new Map(h.storage.listThreadQuestions("t").map((q) => [q.handle, q]))
    h.storage.answerThreadQuestion(byHandle.get("answered")!.id, "{}", Date.parse(at(1)))
    h.storage.withdrawThreadQuestion("t", byHandle.get("withdrawn")!.id, Date.parse(at(1)))
    h.storage.dismissThreadQuestion(byHandle.get("dismissed")!.id, Date.parse(at(1)))
    const before = JSON.stringify(h.storage.listThreadQuestions("t"))
    const late = {
      at: at(5),
      text: [
        followUp("f-answered", "answered = SQLite"), followUp("f-withdrawn", "withdrawn = SQLite"), followUp("f-dismissed", "dismissed = SQLite"),
        followUp("f-unknown", "never-asked = SQLite"), followUp("f-label", "open = sqlite3"),
        followUp("f-multi", "targets = auth"), followUp("f-text", "scope = anything"),
      ].join("\n\n"),
    }
    const out = sync(h.storage, [late])
    assert.deepEqual([out.registered, out.attached], [[], []])
    assert.deepEqual(Object.fromEntries(out.faults.map((f) => [f.id, f.faults[0]])), {
      "f-answered": "it follows `answered`, which was already answered, so there is no open question to hang it from — ask it as its own question, without the `when:` line",
      "f-withdrawn": "it follows `withdrawn`, which was already withdrawn, so there is no open question to hang it from — ask it as its own question, without the `when:` line",
      "f-dismissed": "it follows `dismissed`, which was already dismissed by the human, so there is no open question to hang it from — ask it as its own question, without the `when:` line",
      "f-unknown": "`when: never-asked = SQLite` names `never-asked`, which is neither a question in this message nor an open question of this thread — a follow-up hangs off a question that is still waiting for its answer; to ask this on its own, drop the `when:` line",
      "f-label": "`when:` names the option `sqlite3`, and `open` has only `SQLite`, `JSON file` — write the label exactly as the option has it",
      "f-multi": "`targets` is a `multi`, and a multi's options cannot open follow-ups — several picks would open several at once",
      "f-text": "`when:` names the option `anything`, and `scope` is a free-text question with no options to follow — ask this as its own question, without the `when:` line",
    })
    assert.deepEqual(unaccounted(h.storage, out, late), [])
    assert.equal(JSON.stringify(h.storage.listThreadQuestions("t")), before, "no stored tree was touched")
    // On an autonomous thread the surviving question takes no new branch either.
    const goal = sync(h.storage, [{ at: at(6), text: followUp("f-goal", "open = SQLite") }], { autonomousGoal: "Keep going." })
    assert.match(goal.faults[0].faults[0], /running autonomously, so the question was not asked/)
  } finally { h.close() }
})

test("a late follow-up's id is spent like any other, its depth is counted against the whole tree, and branches may hang off branches", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const branch = (id: string, when: string, question = `${id}?`) => fence(`id: ${id}\nkind: choice\nwhen: ${when}\nquestion: ${question}\noptions:\n  - Yes\n  - No`)
    const t0 = { at: at(0), text: choice("root") }
    const t1 = { at: at(1), text: branch("level-2", "root = SQLite") }
    // A follow-up of the follow-up, by the follow-up's own id: the third and last level.
    const t2 = { at: at(2), text: branch("level-3", "level-2 = yes") }
    const grown = sync(h.storage, [t0, t1, t2])
    assert.deepEqual(grown.faults, [])
    assert.deepEqual(grown.attached.map((a) => a.handles), [["level-2"], ["level-3"]])
    const [q] = h.storage.listThreadQuestions("t")
    assert.deepEqual(questionHandles(JSON.parse(q.spec)), ["root", "level-2", "level-3"])
    const before = q.spec
    const t3 = {
      at: at(3),
      text: [
        branch("level-2", "root = SQLite"),                    // the same follow-up again: a reference
        branch("level-3", "level-2 = Yes", "Something else?"), // a different question on a spent id
        branch("level-3b", "root = JSON file"),                // a sound second branch, in the same message
      ].join("\n\n"),
    }
    // The root's own id, written as a follow-up of its own branch.
    const t4 = { at: at(4), text: branch("root", "level-2 = No") }
    // One level too deep — measured against the stored tree, since its parent is not in the message.
    const t5 = { at: at(5), text: branch("level-4", "level-3 = Yes") }
    const out = sync(h.storage, [t0, t1, t2, t3, t4, t5])
    assert.deepEqual(Object.fromEntries(out.faults.map((f) => [f.id, f.faults[0]])), {
      "level-4": "it would reach level 4 under `root`, and follow-ups go 3 levels deep at most — past that you are asking the human to fill in a form; ask it as its own question, without the `when:` line, or decide it yourself",
      "level-3": "`id: level-3` is already used by a different question on this thread — choose a new id (an id is never reused, even once its question is settled)",
      "root": "`id: root` is already used by a different question on this thread — choose a new id (an id is never reused, even once its question is settled)",
    })
    assert.deepEqual(out.attached, [{ at: at(3), rowId: q.id, handles: ["level-3b"] }], "the sound branch beside the refused ones still attaches")
    assert.deepEqual(unaccounted(h.storage, out, t3), [])
    assert.deepEqual(unaccounted(h.storage, out, t4), [])
    assert.deepEqual(unaccounted(h.storage, out, t5), [])
    const after = JSON.parse(h.storage.listThreadQuestions("t")[0].spec) as AskedQuestion
    assert.deepEqual(questionHandles(after), ["root", "level-2", "level-3", "level-3b"])
    assert.equal(JSON.stringify({ ...after, options: [after.options![0], { label: "JSON file" }] }), before, "nothing already in the tree was rewritten")
    assert.equal(h.storage.listThreadQuestions("t").length, 1)
  } finally { h.close() }
})

test("a fence under a refused question is refused by name too — nothing in a message goes unanswered", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const child = (id: string, when: string) => fence(`id: ${id}\nkind: text\nwhen: ${when}\nquestion: ${id}?`)
    sync(h.storage, [{ at: at(0), text: choice("spent") }])
    // A different question on a spent id, with a follow-up under it; and a tree an autonomous thread may not ask.
    const clash = { at: at(1), text: `${choice("spent", "A different question?")}\n\n${child("under-spent", "spent = SQLite")}` }
    const out = sync(h.storage, [clash])
    assert.deepEqual(out.faults.map((f) => f.id), ["spent", "under-spent"])
    assert.equal(out.faults[1].faults[0], "its `when:` hangs this question off `spent`, which could not register — it goes with it, so write both again")
    assert.deepEqual(unaccounted(h.storage, out, clash), [])
    const auto = { at: at(2), text: `${choice("auto")}\n\n${child("under-auto", "auto = SQLite")}` }
    const refused = sync(h.storage, [auto], { autonomousGoal: "Keep going." })
    assert.deepEqual(refused.cancelled.map((q) => questionHandles(JSON.parse(q.spec))), [["auto", "under-auto"]], "the whole tree is cancelled on the record")
    assert.deepEqual(refused.faults, [])
    assert.deepEqual(unaccounted(h.storage, refused, auto), [])
    // A NEW root whose follow-up reuses a spent id: the branch is cut out and named, the root registers.
    const reuse = { at: at(3), text: `${choice("fresh", "Fresh?")}\n\n${child("spent", "fresh = SQLite")}` }
    const kept = sync(h.storage, [reuse])
    assert.deepEqual(kept.registered.map((q) => questionHandles(JSON.parse(q.spec))), [["fresh"]], "a follow-up never takes its parent down")
    assert.deepEqual(kept.faults.map((f) => f.id), ["spent"])
    assert.deepEqual(unaccounted(h.storage, kept, reuse), [])
  } finally { h.close() }
})

test("a question restated while it was open is not a re-ask once the human has answered it", async () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const sightings = [{ at: at(0), text: choice("settings-store") }, { at: at(5), text: choice("settings-store") }]
    sync(h.storage, sightings)
    const [q] = h.storage.listThreadQuestions("t")
    h.storage.answerThreadQuestion(q.id, JSON.stringify({ questionId: q.id, question: "SQLite or a JSON file?", chosen: ["SQLite"] }), Date.parse(at(8)))
    // The restatement at minute 5 was written while the question was OPEN. Every later tick reads it again.
    const after = sync(h.storage, sightings)
    assert.deepEqual(after.faults, [], "a message from before the answer is not corrected because of the answer")
    // Written AFTER the answer it is a re-ask, as before.
    const reask = sync(h.storage, [...sightings, { at: at(9), text: choice("settings-store") }])
    assert.deepEqual(reask.faults.map((f) => f.at), [at(9)])
  } finally { h.close() }
  // …and so answering a restated question sends the worker its answer and NO correction beside it.
  const c = await correctionHarness([{ at: at(0), text: choice("settings-store") }, { at: at(5), text: choice("settings-store") }])
  try {
    await c.s.tick()
    const [q] = c.storage.listThreadQuestions("t")
    c.storage.answerThreadQuestion(q.id, JSON.stringify({ questionId: q.id, question: "SQLite or a JSON file?", chosen: ["SQLite"] }), Date.parse(at(8)))
    await c.s.tick()
    assert.deepEqual(c.queued().filter((r) => r.fence_id.startsWith("park:question-fence")), [], "no '⚠️ Your ```question fence could not register' for a fence that registered")
    assert.ok(c.queued().some((r) => /^Answers to earlier questions:/.test(r.message)), "the answer itself was queued")
    // …and the wake names the question by the id its fence gave it, ahead of the restated text.
    assert.ok(c.queued().some((r) => r.message.includes("\n1. `settings-store` “SQLite or a JSON file?” → SQLite")), c.queued().map((r) => r.message).join("\n---\n"))
  } finally { c.close() }
})

test("growThreadQuestionSpec rewrites an OPEN question's tree and no other", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    h.storage.upsertSession(row("other"))
    const open = h.storage.askThreadQuestion({ id: "qst_open", slug: "t", spec: "{\"a\":1}", askedAtMs: 1 })
    const answered = h.storage.askThreadQuestion({ id: "qst_answered", slug: "t", spec: "{\"a\":1}", askedAtMs: 2 })
    h.storage.answerThreadQuestion(answered.id, "{}", 3)
    assert.equal(h.storage.growThreadQuestionSpec("t", open.id, "{\"a\":2}"), true)
    assert.equal(h.storage.getThreadQuestion(open.id)?.spec, "{\"a\":2}")
    assert.equal(h.storage.getThreadQuestion(open.id)?.asked_at, 1)
    assert.equal(h.storage.growThreadQuestionSpec("t", answered.id, "{\"a\":2}"), false, "a settled tree is never rewritten under its answer")
    assert.equal(h.storage.growThreadQuestionSpec("other", open.id, "{\"a\":3}"), false, "nor another thread's")
    assert.equal(h.storage.getThreadQuestion(answered.id)?.spec, "{\"a\":1}")
  } finally { h.close() }
})

// ── Replay, whatever the parser reads today ───────────────────────────────────────────────────────────

test("the message that registered a question is never judged against it again, whatever its fence parses to now", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const child = fence("id: sqlite-path\nkind: text\nwhen: settings-store = SQLite\nquestion: Where should it live?")
    const registering = { at: at(0), text: `${choice("settings-store")}\n\n${child}` }
    sync(h.storage, [registering])
    const [q] = h.storage.listThreadQuestions("t")
    // THE ROW AS AN OLDER PARSER READ THE SAME BYTES: another wording, another option list, the branch
    // worded differently too. (The parser has been corrected since rows were first written, and will be again.)
    const older: AskedQuestion = {
      handle: "settings-store", question: "SQLite or a JSON file? (as an older parser read it)", kind: "question",
      options: [{ label: "SQLite", description: "read as a description then", followUps: [{ handle: "sqlite-path", question: "Where?", kind: "question" }] }, { label: "JSON file" }],
    }
    h.storage.growThreadQuestionSpec("t", q.id, JSON.stringify(older))
    const before = JSON.stringify(h.storage.listThreadQuestions("t"))
    const replay = sync(h.storage, [registering])
    assert.deepEqual(replay.faults, [], "no 'id already used by a different question' for the fence that registered it")
    assert.deepEqual([replay.registered, replay.attached], [[], []])
    assert.deepEqual(replay.refs, [{ at: at(0), rowId: q.id }], "it still places its card")
    assert.equal(JSON.stringify(h.storage.listThreadQuestions("t")), before, "and the stored reading is left as it was")
    // Even if today's parser refuses that fence outright, or reads its branch as arriving late.
    const refusedNow = sync(h.storage, [{ at: at(0), text: fence("id: settings-store\nkind: choice\nquestion: SQLite or a JSON file?") }])
    assert.deepEqual(refusedNow.faults, [])
    const lateNow = sync(h.storage, [{ at: at(0), text: `${fence("id: settings-store")}\n\n${child}` }])
    assert.deepEqual([lateNow.faults, lateNow.attached], [[], []])
    // …and the same holds once the human has answered it.
    h.storage.answerThreadQuestion(q.id, "{}", Date.parse(at(3)))
    assert.deepEqual(sync(h.storage, [registering]).faults, [])
    // NEGATIVE CONTROL: the same bytes in ANOTHER message are judged — there the rule has nothing to say.
    const elsewhere = sync(h.storage, [registering, { at: at(1), text: choice("settings-store") }])
    assert.deepEqual(elsewhere.faults.map((f) => [f.at, f.id]), [[at(1), "settings-store"]])
    assert.match(elsewhere.faults[0].faults[0], /already used by a different question/)
  } finally { h.close() }
})

test("two different questions on one id in the registering message are still refused on every replay", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const collision = { at: at(0), text: `${choice("x")}\n\n${choice("x", "A different question?")}` }
    for (let pass = 0; pass < 3; pass++) {
      const out = sync(h.storage, [collision])
      assert.equal(out.faults.length, 1, `pass ${pass}`)
      assert.match(out.faults[0].faults[0], /two different questions in this message use `id: x`/)
    }
    assert.equal(h.storage.listThreadQuestions("t").length, 1)
  } finally { h.close() }
})

// ── A reference to a question that is no longer open ──────────────────────────────────────────────────

test("a reference to an ANSWERED question is a no-op; one to a withdrawn or dismissed question says no answer is coming", async () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    sync(h.storage, [{ at: at(0), text: [choice("answered"), choice("withdrawn", "W?"), choice("dismissed", "D?")].join("\n\n") }])
    const byHandle = new Map(h.storage.listThreadQuestions("t").map((q) => [q.handle, q]))
    h.storage.answerThreadQuestion(byHandle.get("answered")!.id, "{}", Date.parse(at(1)))
    h.storage.withdrawThreadQuestion("t", byHandle.get("withdrawn")!.id, Date.parse(at(1)))
    h.storage.dismissThreadQuestion(byHandle.get("dismissed")!.id, Date.parse(at(1)))
    const out = sync(h.storage, [{ at: at(5), text: [fence("id: answered"), fence("id: withdrawn"), fence("id: dismissed"), fence("id: never-asked")].join("\n\n") }])
    assert.deepEqual(Object.fromEntries(out.faults.map((f) => [f.id, f.faults[0]])), {
      "withdrawn": "`withdrawn` is a question you withdrew, so there is nothing left to reference and the human is not being asked — if you still need it answered, ask it again under a new id",
      "dismissed": "`dismissed` was dismissed by the human without an answer, so there is nothing left to reference and no answer is coming — decide it yourself, or ask it again under a new id if the work cannot go on without one",
      "never-asked": "`id: never-asked` alone references a question, and no question of yours uses that id — to ask a new one, give the fence a `kind:` and a `question:`",
    })
    assert.deepEqual(out.refs, [], "and a settled question is not placed as standing")
    // A correction made only of these reads as 'it placed nothing', never 'the human has NOT been asked'.
    assert.match(questionFenceCorrection(out.faults), /could not register, so it placed nothing:/)
  } finally { h.close() }
  // At the scheduler: resting on a reference to an answered question earns no correction and no bump.
  const answered = await correctionHarness([{ at: at(0), text: choice("settings-store") }, { at: at(5), text: fence("id: settings-store") }], { lastUserAt: at(3) })
  try {
    answered.storage.upsertSession(row("t"))
    syncQuestionFences(answered.storage, { slug: "t", spawnedAt: "2026-10-01T00:00:00.000Z", sightings: [{ at: at(0), text: choice("settings-store") }] })
    const [q] = answered.storage.listThreadQuestions("t")
    answered.storage.answerThreadQuestion(q.id, JSON.stringify({ questionId: q.id, question: "SQLite or a JSON file?", chosen: ["SQLite"] }), Date.parse(at(2)))
    answered.storage.markSettlementDelivered(q.id)
    await answered.s.tick()
    assert.deepEqual(answered.queued().filter((r) => r.fence_id.startsWith("park:question-fence")), [])
    assert.equal(answered.storage.getSession("t")?.park_bumps ?? 0, 0)
  } finally { answered.close() }
})
