// End-to-end gate for the ```question fence (2026-10-13): a worker asks by writing the fence in its own
// message, and the server registers it from the transcript. This drives that seam on a REAL disposable
// stack — a simulated worker's JSONL, read by the real tailer, registered by the real registrar, projected
// by the real board, settled through the real RPCs the worker's `frizzctl` and the human's card call.
//
// What it pins, each against the running server rather than a unit's stand-in:
//   1. A fence in an assistant message registers ONE question: the worker's id as its handle, asked at the
//      record's own timestamp, the `when:` follow-up attached under its parent option, the body below
//      `---` kept as context — and the thread queues. The latency from append to board is printed.
//   2. A fence quoted inside an outer code block registers nothing (the protocol stays quotable).
//   3. `done` in the same breath as a new fence is refused and names that fence's id — the gate catches
//      the registrar up rather than judging a transcript a second stale.
//   4. `unask` takes the worker's own id; the card's `answerQuestions` settles the row by its `qst_…`.
//   5. A settled id asked again with a different question is refused — ids are never reused.
//   6. A thread dispatched before 2026-09-11 keeps the legacy grammar: the same fence registers nothing.
//
// It leaves `qf-shot` with one open question placed mid-handoff, for a screenshot of the card in its slot.
//
// Boot a stack first (see .agents/skills/frizz-stack), then:
//   nub scripts/verify-question-fence.mjs --home=/abs/temp-home --port=NNNN
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, port, cwd = process.cwd() } = flags
if (!home || !port) {
  console.error("usage: nub scripts/verify-question-fence.mjs --home=/abs/temp-home --port=NNNN")
  process.exit(1)
}

const db = join(home, ".frizz", "ui.db")
if (!existsSync(db)) throw new Error(`no ui.db at ${db} — is the stack booted?`)
const registry = JSON.parse(readFileSync(join(home, ".frizz", "registry.json"), "utf8"))
const projectId = registry.projects.find((p) => p.path === cwd)?.id
if (!projectId) throw new Error(`${cwd} is not registered in ${home}/.frizz/registry.json`)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const api = createRpcClient(`http://127.0.0.1:${port}/`)
if (!(await api.waitForHealth())) throw new Error("the stack never answered /health")

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const threadOf = async (slug) => (await api.query("board")).threads.find((t) => t.id === slug)
async function until(what, probe, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = await probe()
    if (got) return got
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

// ---- the simulated worker ---------------------------------------------------------------------------

function worker({ slug, sessionId, spawnedAt, title }) {
  let n = 0
  const uuid = () => `${sessionId.slice(0, 24)}${String(++n).padStart(12, "0")}`
  const path = join(jsonlDir, `${sessionId}.jsonl`)
  const base = (type, at) => ({ parentUuid: null, isSidechain: false, type, uuid: uuid(), timestamp: at, session_id: sessionId, cwd })
  const write = (rec) => appendFileSync(path, JSON.stringify(rec) + "\n")
  writeFileSync(path, "")
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode)
     VALUES ('${projectId}', '${slug}', '${sessionId}', 'frizz-${slug}', '${spawnedAt}', '${title}', 'claude', 'opus', 'high', 'default')`,
  ])
  return {
    slug,
    user(text, at = new Date().toISOString()) {
      write({ ...base("user", at), message: { role: "user", content: text } })
      return at
    },
    /** One assistant message at rest. Returns the record's timestamp — the instant a question is asked at. */
    say(text, at = new Date().toISOString()) {
      write({
        ...base("assistant", at),
        message: {
          model: "claude-opus-5", id: `msg_${n}`, type: "message", role: "assistant", stop_reason: "end_turn",
          content: [{ type: "text", text }], usage: { input_tokens: 38_000, output_tokens: 280 },
        },
      })
      return at
    },
  }
}

const SETTINGS_FENCE = [
  "```question",
  "id: settings-store",
  "kind: choice",
  "header: Settings store",
  "question: Should the settings store use SQLite or a JSON file?",
  "options:",
  "  - label: SQLite",
  "    description: transactional, and one store to back up",
  "    recommended: true",
  "  - label: JSON file",
  "    description: no dependency, hand-editable",
  "---",
  "Settings are read on every request and written by the server and by every worker's `frizzctl` calls.",
  "",
  "| Store | Survives a crash mid-write | Concurrent writers |",
  "|---|---|---|",
  "| SQLite | yes | safe |",
  "| JSON file | no | last write wins |",
  "```",
].join("\n")
const FOLLOW_UP_FENCE = [
  "```question",
  "id: sqlite-path",
  "kind: choice",
  "when: settings-store = SQLite",
  "question: Where should the database file live?",
  "options:",
  "  - label: Beside the sessions database",
  "  - label: In the project's `.frizz/`",
  "```",
].join("\n")
const QUOTED_SAMPLE = ["````md", "```question", "id: quoted-sample", "kind: text", "question: Only an example of the grammar", "```", "````"].join("\n")
const ASKING_HANDOFF = [
  "**Needs you** — the settings layer is written against an interface; the store behind it is the open call.",
  "",
  "The two candidates differ on what happens when two writers land at once:",
  "",
  SETTINGS_FENCE,
  "",
  FOLLOW_UP_FENCE,
  "",
  "For reference, the grammar a worker writes looks like this — quoted, so it is not a question:",
  "",
  QUOTED_SAMPLE,
  "",
  "Everything that does not depend on the answer is committed on `main`.",
].join("\n")

const now = Date.now()
const minutesAgo = (m) => new Date(now - m * 60_000).toISOString()

// ---- 1, 2: a fence registers; a quoted one does not ------------------------------------------------

const live = worker({ slug: "qf-live", sessionId: "9f0e1a00-0000-4000-9000-0000000000a1", spawnedAt: minutesAgo(10), title: "Settings store" })
live.user("move the settings into a real store", minutesAgo(10))
live.say("Reading the settings layer.", minutesAgo(9))
await until("qf-live on the board", () => threadOf("qf-live"))

const t0 = Date.now()
const askedAt = live.say(ASKING_HANDOFF)
const asked = await until("the settings-store question on the board", async () => {
  const t = await threadOf("qf-live")
  return t?.questions?.find((q) => q.spec.handle === "settings-store") ? t : undefined
})
console.log(`      registered ${Date.now() - t0}ms after the append`)
const q = asked.questions.find((x) => x.spec.handle === "settings-store")
check("one question registered for the two fences (the follow-up rides its parent)", asked.questions.length === 1, `${asked.questions.length} open`)
check("its id is a minted qst_… and its handle the worker's id", /^qst_/.test(q.id) && q.spec.handle === "settings-store", q.id)
check("asked at the record's own timestamp", q.askedAt === askedAt, `${q.askedAt} vs ${askedAt}`)
check("a choice with two options, SQLite recommended", q.spec.kind === "question" && q.spec.options?.length === 2 && q.spec.options[0].recommended === true)
const follow = q.spec.options?.find((o) => o.label === "SQLite")?.followUps?.[0]
check("the `when:` follow-up hangs under SQLite with its own handle", follow?.handle === "sqlite-path" && follow?.question === "Where should the database file live?")
check("the body below `---` is the question's context, table included", q.spec.context?.includes("| JSON file | no | last write wins |") === true)
check("the header chip came through", q.spec.header === "Settings store")
check("the thread queues on it", asked.needsYou === true)
check("the quoted sample registered nothing", !asked.questions.some((x) => x.spec.handle === "quoted-sample"))

// ---- 3: `done` in the same breath as a new fence ----------------------------------------------------

live.user("also: which npm scope?")
live.say(["One more input before the publish step can be written.", "", "```question", "id: npm-scope", "kind: text", "question: What npm scope should the new packages publish under?", "```"].join("\n"))
const refusal = await api.mutate("markOwnDone", { slug: "qf-live", body: "- Moved the settings into a store." })
check("`done` written with the fence is refused", refusal.done === false)
check("…naming the new fence by the worker's id", refusal.blockingQuestions.some((b) => b.id === "npm-scope"), refusal.blockingQuestions.map((b) => b.id).join(", "))
check("…and the older one too", refusal.blockingQuestions.some((b) => b.id === "settings-store"))

// ---- 4: unask by the worker's id; answer by the card's ------------------------------------------------

const unasked = await api.mutate("unask", { slug: "qf-live", id: "npm-scope" })
check("`unask npm-scope` withdraws it", unasked.withdrawn === true && !unasked.open.some((o) => o.handle === "npm-scope"))
const answered = await api.mutate("answerQuestions", {
  slug: "qf-live",
  answers: [{ questionId: q.id, question: q.spec.question, chosen: ["JSON file"] }],
})
check("the card's answer settles the row", answered.answered.includes(q.id) && answered.open.length === 0)
const afterAnswer = await until("the board to drop the answered card", async () => {
  const t = await threadOf("qf-live")
  return t && t.questions.length === 0 ? t : undefined
})
check("no open question left on the board", afterAnswer.questions.length === 0)

// ---- 5: a settled id is never reused ------------------------------------------------------------------

live.user("thanks")
live.say(["Switching to the JSON file.", "", "```question", "id: settings-store", "kind: text", "question: Which directory should the JSON file live in?", "```"].join("\n"))
await sleep(2500)
const reuse = await threadOf("qf-live")
check("asking a settled id again registers nothing", reuse.questions.length === 0, `${reuse.questions.length} open`)
const rows = execFileSync("sqlite3", [db, `SELECT count(*) FROM thread_question WHERE thread_slug = 'qf-live'`]).toString().trim()
check("…and writes no row (settings-store + npm-scope only)", rows === "2", `${rows} rows`)

// ---- 6: a legacy thread keeps its grammar -------------------------------------------------------------

const legacy = worker({ slug: "qf-legacy", sessionId: "9f0e1a00-0000-4000-9000-0000000000b2", spawnedAt: "2026-09-01T12:00:00.000Z", title: "Legacy thread" })
legacy.user("same task, older contract", minutesAgo(8))
legacy.say(ASKING_HANDOFF)
await until("qf-legacy on the board", () => threadOf("qf-legacy"))
await sleep(2500)
const legacyRows = execFileSync("sqlite3", [db, `SELECT count(*) FROM thread_question WHERE thread_slug = 'qf-legacy'`]).toString().trim()
check("a thread dispatched before 2026-09-11 registers nothing from the fence", legacyRows === "0", `${legacyRows} rows`)

// ---- the screenshot fixture -----------------------------------------------------------------------------

const shot = worker({ slug: "qf-shot", sessionId: "9f0e1a00-0000-4000-9000-0000000000c3", spawnedAt: minutesAgo(6), title: "Settings store — open question" })
shot.user("move the settings into a real store", minutesAgo(6))
shot.say("Reading the settings layer.", minutesAgo(5))
shot.say(ASKING_HANDOFF)
await until("qf-shot's question on the board", async () => (await threadOf("qf-shot"))?.questions?.length === 1)
console.log(`      screenshot fixture: qf-shot`)

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
