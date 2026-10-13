// Delivery gate for the ```question fence (2026-10-13): every message Frizz sends a worker ABOUT its
// questions, driven through the real path — scheduler → outbox → broker daemon → the worker's next turn →
// its transcript → the registrar reading what the worker wrote back.
//
// WHY IT NEEDS A REAL BROKER. scripts/verify-question-fence.mjs appends records to a JSONL on a stack whose
// scheduler is off: it proves what the server READS. Nothing there can show a correction, an answer or a
// cancellation ARRIVING — the outbox claiming it, the broker socket taking it, the worker's process writing
// it as a user record, and the worker's reply closing the loop — and that seam is where a feature like this
// breaks. So the worker here is scripts/scripted-claude.mjs: a stand-in `claude` the real dispatch forks
// under the real broker daemon, which writes the real transcript and runs `frizzctl` for real, and whose
// every turn this file scripts (`[script file=…]`, see that file's header). Only the model is replaced.
//
// What each case pins, on the running server and in the worker's own transcript:
//   0. (in A) The worker's `frizzctl` is the one beside this stack's server and its lock names this port —
//      a stack booted from inside a Frizz worker inherits the machine's own Frizz on PATH.
//   A. A broken fence is corrected, once, and the fix registers. A fence with no `kind:` faults the thread
//      on the board, the scheduler's correction reaches the worker as a wake, the scripted reply writes
//      the fence again and it registers at that message's instant; the thread queues on it, the board
//      drops the fault, and two ticks later there is still exactly one correction.
//   B. An answer is delivered. Two questions, one with a `when:` follow-up; the card's own RPC answers the
//      first and its wake reaches the worker restating what was asked and what was picked. The worker
//      replies WITHOUT naming the second question, which still stands and still queues the thread: an
//      answer wake is not the human typing. The second answer signs the thread off. Each settlement is
//      marked delivered, and neither is offered twice.
//   C. A question stands across a Frizz wake and fades when the human types. The worker asks and arms a
//      timer; the timer's wake and a reply that says nothing of the question leave it `standing`. The
//      human types (`followUp`, the prompt box's call) and the worker replies past it: `standing: false`,
//      still open. The sign-off reminder that bare rest earns is answered with a reference fence (`id:`
//      alone): standing again. Then the faded-and-restored question is answered like any other.
//   D. An autonomous thread. A Goal armed through the Goal panel's RPC; the worker writes a question fence:
//      one row, dismissed; one cancellation wake naming the id; no correction; `closedQuestions` on the
//      board. A `kind: secret` question written in the reply to that wake still asks.
//   E. The commands, run by the worker itself. `frizzctl done` with a question open: exit 2, naming it by
//      the worker's id. `frizzctl unask <a follow-up's id>`: withdraws nothing and names the root.
//      `frizzctl ask`: exit 2, and prints a fence. `frizzctl unask <id>` then `frizzctl done`: accepted.
//   G. A second broken fence in a row. The correction of the fence the worker got wrong AGAIN follows a
//      wake Frizz handed the thread seconds earlier, and still arrives within a tick: a correction answers
//      the worker's own rest, so the outbox's five-minute quiet window (wake-store.ts) must not hold it.
//   F. A restart mid-wait. One question open and standing, a second fence broken, and the server stopped
//      after that rest reached the transcript and before the scheduler's next tick could correct it. Booted
//      again on the same HOME it adopts the broker daemon it did not fork, delivers the correction once,
//      registers the fix, and leaves the first question's row byte-identical. A second thread covers the
//      other side of the stop: its correction was SENT by the old server and its worker is still thinking
//      when that wake's confirmation window runs out under the new one, which must not send it again.
//
// TIMING. The scheduler ticks every TICK_MS (scheduler.ts `tickMs`) and a tick enqueues AND delivers, so a
// correction, a timer or a reminder lands within one tick of the tailer folding the rest (it polls about
// once a second). An answer and a Goal's cancellation do not wait for the tick: their RPCs `kick()` the
// sweep. A wake to a live broker is filed `leased` when sent and settled by the tick that next looks at it
// — `delivered` once CONFIRM_GRACE_MS has passed with the runtime alive, or `superseded` the moment the
// worker's reply moves the rest it was bound to (a correction, a reminder). Every wait below polls for its
// condition under a deadline sized from those, and "no second one" is read two ticks after the thread's
// outbox has gone quiet.
//
// ADDING A CASE: one entry in CASES. `t.worker(name, turns)` dispatches a scripted thread; `on` keys a
// turn to the message it answers; `t.hold(flag)` is a tool call that keeps a turn open until
// `w.release(flag)`, which is how a state that lasts milliseconds is held still long enough to read.
//
// Boot a stack with the scripted worker and the scheduler armed (`--keep`, or case F cannot restart it),
// from a shell with no Frizz worker variables in it, then:
//   nub scripts/adhoc-stack.mjs --port=NNNN --wakers --keep --project=/abs/throwaway-repo \
//     --claude-bin=/abs/path/to/scripts/scripted-claude.mjs
//   nub scripts/verify-question-fence-wakes.mjs --home=/abs/temp-home --port=NNNN [--log=/abs/server.log]
//     [--only=A,C] [--skip=F] [--serial] [--run=2] [--cwd=/abs/throwaway-repo]
// The cases run side by side (they share nothing but the server), which is fast but lets one case's RPC
// kick the sweep for another; `--serial` runs them one at a time, for latencies that are each case's own.
// `--log` is the server's own log (boot the stack with FRIZZ_LOG_PATH=/abs/server.log); a failing case
// quotes its lines. Case F stops the stack by pid and boots it again with the same arguments, so the pid
// to kill afterwards is the one this prints. Dispatched workers are DETACHED: kill each by pid when done.
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync, spawn } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { BURIED_ANSWERS_HEADER, QUESTION_FENCE_CORRECTION_LEAD, SIGNOFF_NUDGE_MARKER } from "../packages/shared/src/index.ts"

const USAGE = "usage: nub scripts/verify-question-fence-wakes.mjs --home=/abs/temp-home --port=NNNN [--log=/abs/server.log] [--only=A,B] [--skip=F] [--serial] [--run=N] [--cwd=/abs/project]"
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
const { home, port, log, run = "1" } = flags
if (!home || !port) {
  console.error(USAGE)
  process.exit(1)
}

const TICK_MS = 10_000 // scheduler.ts createScheduler: `tickMs`
const TAILER_MS = 1_500 // the tailer's poll, with headroom
const CONFIRM_GRACE_MS = 60_000 // scheduler.ts `confirmGraceMs`: how long a SENT wake stays leased
const WAKE_MS = TAILER_MS + 2 * TICK_MS + 5_000 // a tick-driven wake: fold, the next tick, and one to spare
const KICK_MS = 12_000 // a wake whose RPC kicks the sweep
const TURN_MS = 15_000 // a scripted turn, start to rest
const BOARD_MS = 10_000 // a folded record reaching the board
const SLOW_TURN_MS = CONFIRM_GRACE_MS + 2 * TICK_MS // a turn that outlasts its wake's confirmation window

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const db = join(home, ".frizz", "ui.db")
if (!existsSync(db)) throw new Error(`no ui.db at ${db} — is the stack booted?`)
const registry = JSON.parse(readFileSync(join(home, ".frizz", "registry.json"), "utf8"))
const cwd = flags.cwd ?? (registry.projects.length === 1 ? registry.projects[0].path : process.cwd())
const project = registry.projects.find((p) => p.path === cwd)
if (!project) throw new Error(`${cwd} is not registered in ${home}/.frizz/registry.json — pass --cwd=<the stack's --project>`)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
const scratch = join(home, "qf-wakes")
mkdirSync(scratch, { recursive: true })

let api = createRpcClient(`http://127.0.0.1:${port}/`, project.id)
if (!(await api.waitForHealth())) throw new Error("the stack never answered /health")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// (Not `-readonly`: the database is in WAL mode, and with the server stopped — case F — a read-only
// connection cannot create the shared-memory file it needs and fails to open at all. Every query is a SELECT.)
const sql = (q) => JSON.parse(execFileSync("sqlite3", ["-json", db, q], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim() || "[]")
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`
const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
const threadOf = async (slug) => (await api.query("board")).threads.find((t) => t.id === slug)
const WAKE_TOKEN = /<!-- frizz-wake:[0-9a-f]+ -->\s*$/
const FIRST = "[script file=" // the dispatch prompt: every scripted thread's first turn answers it
const GOAL_TRAILER = "(Goal — sent each time you come to rest"
const CANCELLED = "CANCELLED without an answer"
const TIMER_TRAILER = "(One-off timer, set for"
const TIMER_S = 10 // the shortest `frizzctl timer set --in-seconds` accepts

async function until(what, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = await probe()
    if (got) return got
    if (Date.now() > deadline) throw new Error(`timed out after ${secs(timeoutMs)} waiting for ${what}`)
    await sleep(60)
  }
}

const fence = (...lines) => ["```question", ...lines, "```"].join("\n")
const choice = (id, question, labels, extra = []) =>
  fence(`id: ${id}`, "kind: choice", ...extra, `question: ${question}`, "options:", ...labels.flatMap((l, i) => [`  - label: ${l}`, ...(i === 0 ? ["    recommended: true"] : [])]))

// ---- one case's context --------------------------------------------------------------------------------

function caseContext(key) {
  const lines = []
  const workers = []
  const t = {
    key,
    failures: 0,
    lines,
    workers,
    check(label, ok, detail) {
      lines.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
      if (!ok) t.failures++
      return ok
    },
    note: (text) => lines.push(`      ${text}`),
    /** A tool call that holds its turn open until `w.release(flag)`. */
    hold: (flag) => ({ command: `while [ ! -e ${quote(join(scratch, `${key}-${run}.${flag}.flag`))} ]; do sleep 0.1; done`, description: `Waiting for the verifier (${flag})`, timeout: 300_000 }),
    /** Dispatch one scripted thread through the real `dispatch` RPC. */
    async worker(name, turns) {
      const slug = `wk-${key.toLowerCase()}-${name}${run === "1" ? "" : `-${run}`}`
      const file = join(scratch, `${slug}.turns.json`)
      writeFileSync(file, JSON.stringify({
        think: 150,
        turns,
        // Anything nothing was scripted for is answered, so the thread cannot hang, and counted as a failure.
        otherwise: { name: "unscripted", text: "Nothing was scripted for that message." },
      }, null, 1))
      const sentAt = Date.now()
      const { sessionId } = await api.mutate("dispatch", { prompt: `[script file=${file}] ${name}`, backend: "claude", slug, title: `Question wakes ${key}: ${name}` })
      const w = workerHandle(t, slug, sessionId, file, sentAt)
      workers.push(w)
      return w
    },
  }
  return t
}

function workerHandle(t, slug, sessionId, file, sentAt) {
  const path = join(jsonlDir, `${sessionId}.jsonl`)
  const records = () => {
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8").split("\n").flatMap((line, index) => {
      try {
        return line ? [{ index, ...JSON.parse(line) }] : []
      } catch {
        return [] // a last line caught mid-write
      }
    })
  }
  /** The messages that started a turn: every user record with a string body. */
  const starts = () => records().filter((r) => r.type === "user" && typeof r.message?.content === "string")
    .map((r) => ({ index: r.index, at: r.timestamp, text: r.message.content, wake: WAKE_TOKEN.test(r.message.content) }))
  /** The messages a turn ended on. */
  const rests = () => records().filter((r) => r.type === "assistant" && r.message?.stop_reason === "end_turn")
    .map((r) => ({ index: r.index, at: r.timestamp, text: r.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") }))
  const w = {
    slug, sessionId, path, file, sentAt, records, starts, rests,
    /** The first turn-starting message containing `needle` after transcript line `after`. */
    start: (needle, { after = -1, timeoutMs = TURN_MS, what = needle } = {}) =>
      until(`${slug}: a message carrying “${what}”`, () => starts().find((s) => s.index > after && s.text.includes(needle)), timeoutMs),
    /** The rest that answers the turn `start` opened. */
    restAfter: (start, timeoutMs = TURN_MS) => until(`${slug}: the rest after line ${start.index}`, () => rests().find((r) => r.index > start.index), timeoutMs),
    /** The board, once it has folded `rest` and the thread is idle there. */
    settled: (rest, timeoutMs = BOARD_MS) => until(`${slug}: the board at the rest of ${rest.at}`, async () => {
      const thread = await threadOf(slug)
      return thread?.lastAssistantAt && Date.parse(thread.lastAssistantAt) === Date.parse(rest.at) && thread.runtime === "turn-idle" ? thread : undefined
    }, timeoutMs),
    board: () => threadOf(slug),
    /** Every Bash call the worker ran, with what came back. */
    tools() {
      const all = records()
      const results = new Map(all.flatMap((r) => (r.type === "user" && Array.isArray(r.message?.content) ? r.message.content.filter((b) => b.type === "tool_result").map((b) => [b.tool_use_id, b]) : [])))
      return all.flatMap((r) => (r.type === "assistant" ? r.message.content.filter((b) => b.type === "tool_use") : [])).map((call) => {
        const result = results.get(call.id)
        const output = typeof result?.content === "string" ? result.content : ""
        const exit = /^Exit code (\d+)/.exec(output)
        return { command: call.input.command, output, exitCode: result ? (exit ? Number(exit[1]) : 0) : undefined }
      })
    },
    tool: (needle) => w.tools().find((c) => c.command.includes(needle)),
    release: (flag) => writeFileSync(join(scratch, `${t.key}-${run}.${flag}.flag`), ""),
    count: (needle) => starts().filter((s) => s.text.includes(needle)).length,
    questions: () => sql(`SELECT id, handle, state, asked_at, settled_at, delivered, delivery_id, spec, answer FROM thread_question WHERE thread_slug = ${quote(slug)} ORDER BY asked_at, rowid`),
    deliveries: () => sql(`SELECT id, fence_id, reason, state, attempts, last_error, created_at, next_attempt_at, sent_at, delivered_at, terminal_at FROM wake_delivery WHERE thread_slug = ${quote(slug)} ORDER BY created_at, rowid`),
    /** Wait until nothing for this thread is pending or leased, then two more ticks: time enough for
     *  anything that was going to be sent again to have been. */
    async quiet(timeoutMs = CONFIRM_GRACE_MS + 3 * TICK_MS) {
      await until(`${slug}: its outbox going quiet`, () => !w.deliveries().some((d) => d.state === "pending" || d.state === "leased"), timeoutMs)
      await sleep(2 * TICK_MS + 1_000)
    },
    /** Which script entry answered which message (scripted-claude's own log). */
    choices: () => (existsSync(`${file}.log`) ? readFileSync(`${file}.log`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    digest() {
      return records().flatMap((r) => {
        const c = r.message?.content
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b.text ?? (b.type === "tool_use" ? `$ ${b.input?.command}` : b.type === "tool_result" ? `→ ${b.content}` : "")).join(" ") : r.type === "queue-operation" ? `${r.operation}` : ""
        return r.type === "user" || r.type === "assistant" ? [`  ${r.timestamp}  ${r.type.padEnd(9)} ${text.replace(/\s+/g, " ").slice(0, 300)}`] : []
      })
    },
  }
  return w
}

/** Every thread of a case answered each message from its script — nothing fell to the `otherwise` turn. */
function expectScripted(t) {
  for (const w of t.workers) {
    const stray = w.choices().filter((c) => c.entry === "otherwise" || c.entry === "generated")
    t.check(`${w.slug}: every message it received was one the script expected`, stray.length === 0, stray.map((c) => c.message.replace(/\s+/g, " ").slice(0, 80)).join(" | "))
  }
}

// ---- the cases -------------------------------------------------------------------------------------------

const CASES = [
  {
    key: "A",
    title: "a broken fence is corrected, once, and the fix registers",
    async run(t) {
      const question = "Should the build cache live in Redis or on local disk?"
      const broken = fence("id: cache-store", `question: ${question}`, "options:", "  - label: Redis", "    recommended: true", "  - label: Local disk")
      const fixed = choice("cache-store", question, ["Redis", "Local disk"])
      const w = await t.worker("fix", [
        { name: "asks with a fence that has no kind", on: FIRST, tools: [{ command: 'command -v frizzctl; cat "$FRIZZ_SERVER_LOCK"', description: "Which frizzctl, and which server" }], text: `The build cache needs a home before the CI change can land.\n\n${broken}` },
        { name: "writes the fence again, corrected", on: QUESTION_FENCE_CORRECTION_LEAD, tools: [t.hold("fix")], text: `The fence was missing its kind.\n\n${fixed}` },
      ])
      const first = await w.start(FIRST)
      const rest1 = await w.restAfter(first)
      t.note(`dispatch → first rest ${secs(Date.parse(rest1.at) - w.sentAt)}`)

      // 0. whose frizzctl, and whose server
      const probe = w.tool("command -v frizzctl")
      const [bin, lock] = (probe?.output ?? "").split("\n")
      t.check("the worker's frizzctl is the one beside this stack's server", bin === join(repoRoot, "cc-worker", "bin", "frizzctl"), bin)
      let lockPort
      try { lockPort = JSON.parse(lock).port } catch {}
      t.check("…and the lock it reads names this stack's port", String(lockPort) === String(port), `server.lock says ${lockPort}`)
      t.note(`frizzctl reaches http://127.0.0.1:${lockPort} (FRIZZ_SERVER_LOCK → pid ${(() => { try { return JSON.parse(lock).pid } catch { return "?" } })()})`)

      const correction = await w.start(QUESTION_FENCE_CORRECTION_LEAD, { after: rest1.index, timeoutMs: WAKE_MS, what: "the correction" })
      t.note(`correction reached the worker ${secs(Date.parse(correction.at) - Date.parse(rest1.at))} after its rest (a tick is ${secs(TICK_MS)})`)
      t.check("the correction arrives as a wake and opens on the correction lead", correction.wake && correction.text.startsWith(QUESTION_FENCE_CORRECTION_LEAD))
      t.check("…naming the fence by the worker's id and the fault", correction.text.includes("`cache-store`") && correction.text.includes("no `kind:`"), correction.text.split("\n").find((l) => l.startsWith("- ")))
      const faulted = await until("the fault on the board", async () => {
        const thread = await w.board()
        return thread?.questionFaults?.some((f) => f.id === "cache-store") ? thread : undefined
      }, BOARD_MS)
      t.check("while uncorrected the board lists the fault and no question", faulted.questions.length === 0 && faulted.questionFaults.length === 1, JSON.stringify(faulted.questionFaults))
      t.check("…and nothing is registered", w.questions().length === 0)

      w.release("fix")
      const rest2 = await w.restAfter(correction)
      const after = await w.settled(rest2)
      const q = after.questions.find((x) => x.spec.handle === "cache-store")
      t.check("the corrected fence registers under the worker's id", q !== undefined && /^qst_/.test(q?.id ?? ""), q?.id)
      t.check("…asked at the instant of the message that fixed it", q?.askedAt === rest2.at, `${q?.askedAt} vs ${rest2.at}`)
      t.check("the thread queues on it, standing", after.needsYou === true && q?.standing === true, `needsYou ${after.needsYou}, standing ${q?.standing}`)
      t.check("the board lists no fault for the thread any more", !after.questionFaults?.length, JSON.stringify(after.questionFaults))

      await w.quiet()
      t.check("exactly one correction was sent for that rest", w.count(QUESTION_FENCE_CORRECTION_LEAD) === 1, `${w.count(QUESTION_FENCE_CORRECTION_LEAD)} in the transcript`)
      const corrections = w.deliveries().filter((d) => d.fence_id.startsWith("park:question-fence:"))
      t.check("…and exactly one was ever queued", corrections.length === 1, corrections.map((d) => `${d.fence_id} ${d.state}`).join(", "))
      t.note(`its outbox row ended ${corrections[0]?.state}${corrections[0]?.last_error ? ` (“${corrections[0].last_error}”)` : ""}, sent ${corrections[0]?.sent_at ? "yes" : "no"}`)
      t.check("no sign-off reminder was sent on top of it", w.count(SIGNOFF_NUDGE_MARKER) === 0)
      t.check("one row, still open", w.questions().length === 1 && w.questions()[0].state === "open")
    },
  },

  {
    key: "B",
    title: "an answer is delivered, and does not reply past the other question",
    async run(t) {
      const engineQ = "Should the settings store use SQLite or Postgres?"
      const pathQ = "Where should the SQLite file live?"
      const channelQ = "Which release channel should the first build ship on?"
      const w = await t.worker("answers", [
        {
          name: "asks two questions, one with a follow-up", on: FIRST,
          text: [
            "Two calls are open before the settings layer can be finished.",
            choice("db-engine", engineQ, ["SQLite", "Postgres"]),
            choice("db-path", pathQ, ["Beside the sessions database", "Its own file"], ["when: db-engine = SQLite"]),
            choice("release-channel", channelQ, ["Beta", "Stable"]),
          ].join("\n\n"),
        },
        { name: "hears the first answer and carries on", on: BURIED_ANSWERS_HEADER, text: "Recorded: SQLite, beside the sessions database. The schema work carries on from here." },
        { name: "hears the second answer and signs off", on: BURIED_ANSWERS_HEADER, text: "Beta it is.\n\n```done\n- **Settings store wired to SQLite** beside the sessions database, shipping on the beta channel.\n```" },
      ])
      const rest1 = await w.restAfter(await w.start(FIRST))
      const asked = await until("both questions on the board", async () => {
        const thread = await w.board()
        return thread?.questions?.length === 2 ? thread : undefined
      }, BOARD_MS)
      const engine = asked.questions.find((q) => q.spec.handle === "db-engine")
      const channel = asked.questions.find((q) => q.spec.handle === "release-channel")
      t.note(`both registered ${secs(Date.now() - Date.parse(rest1.at))} after the rest`)
      t.check("two questions registered; the `when:` follow-up rides its parent", engine?.spec.options?.[0].followUps?.[0]?.handle === "db-path" && channel !== undefined)
      t.check("both stand and the thread queues", engine?.standing === true && channel?.standing === true && asked.needsYou === true)
      const channelRow = w.questions().find((r) => r.handle === "release-channel")

      // The first answer, through the card's own RPC.
      const answeredAt = Date.now()
      const first = await api.mutate("answerQuestions", {
        slug: w.slug,
        answers: [{ questionId: engine.id, question: engineQ, chosen: ["SQLite"], followUps: [{ questionId: "db-path", question: pathQ, chosen: ["Beside the sessions database"] }] }],
      })
      t.check("the card's answer settles the first question only", first.answered.length === 1 && first.answered[0] === engine.id && first.open.length === 1)
      const wake1 = await w.start(BURIED_ANSWERS_HEADER, { after: rest1.index, timeoutMs: KICK_MS, what: "the answer" })
      t.note(`answer reached the worker ${secs(Date.parse(wake1.at) - answeredAt)} after the RPC (the sweep is kicked, not ticked)`)
      t.check("the answer arrives as a wake", wake1.wake && wake1.text.startsWith(BURIED_ANSWERS_HEADER))
      t.check("…naming what was asked and what was picked", wake1.text.includes(engineQ) && wake1.text.includes("SQLite"), wake1.text.split("\n")[1])
      t.check("…with the follow-up's answer under it", wake1.text.includes(pathQ) && wake1.text.includes("Beside the sessions database"), wake1.text.split("\n")[2])
      t.check("…and nothing about the question still open", !wake1.text.includes(channelQ))
      t.note(`the wake names the question by ${wake1.text.includes("`db-engine`") ? "the worker's id and its text" : "its text only (no worker id)"}`)

      const rest2 = await w.restAfter(wake1)
      const between = await w.settled(rest2)
      const still = between.questions.find((q) => q.spec.handle === "release-channel")
      t.check("after a reply that never mentions it, the second question is the one open", between.questions.length === 1 && still !== undefined)
      t.check("…and still STANDS: the answer's delivery did not move its boundary", still?.standing === true, `standing ${still?.standing}`)
      t.check("…so the thread still queues on it", between.needsYou === true)
      const channelNow = w.questions().find((r) => r.handle === "release-channel")
      t.check("…its row untouched", JSON.stringify(channelNow) === JSON.stringify(channelRow))
      // One full tick at that rest: the reminder must not read it as a bare one.
      await sleep(TICK_MS + TAILER_MS)
      t.check("no sign-off reminder for the rest the standing question signs", w.count(SIGNOFF_NUDGE_MARKER) === 0)

      const answered2At = Date.now()
      await api.mutate("answerQuestions", { slug: w.slug, answers: [{ questionId: channel.id, question: channelQ, chosen: ["Beta"] }] })
      const wake2 = await w.start(BURIED_ANSWERS_HEADER, { after: rest2.index, timeoutMs: KICK_MS, what: "the second answer" })
      t.note(`second answer reached the worker ${secs(Date.parse(wake2.at) - answered2At)} after the RPC`)
      t.check("the second answer names its own question and not the first", wake2.text.includes(channelQ) && wake2.text.includes("Beta") && !wake2.text.includes(engineQ))
      const rest3 = await w.restAfter(wake2)
      const done = await w.settled(rest3)
      t.check("the board shows no open question", done.questions.length === 0 && done.pendingQuestion === false)
      t.check("…and the thread has signed off rather than waiting on an answer", done.lastFence?.kind === "done" && done.answersInFlight === undefined, `lastFence ${done.lastFence?.kind}`)

      const deliveredAt = Date.now()
      await until("both settlements marked delivered", () => w.questions().every((r) => r.state === "answered" && r.delivered === 1), CONFIRM_GRACE_MS + 3 * TICK_MS)
      t.note(`both rows read delivered ${secs(Date.now() - answeredAt)} after the first answer (a sent wake is confirmed after ${secs(CONFIRM_GRACE_MS)}; waited ${secs(Date.now() - deliveredAt)} more for it)`)
      await w.quiet()
      t.check("each answer was delivered once", w.count(BURIED_ANSWERS_HEADER) === 2, `${w.count(BURIED_ANSWERS_HEADER)} answer wakes in the transcript`)
      const carriers = w.deliveries().filter((d) => d.fence_id.startsWith("question-answer") || /answer/.test(d.reason))
      t.check("…by two outbox rows, both delivered", carriers.length === 2 && carriers.every((d) => d.state === "delivered"), carriers.map((d) => `${d.reason}: ${d.state}`).join("; "))
    },
  },

  {
    key: "C",
    title: "a question stands across a Frizz wake and fades when the human types",
    async run(t) {
      const question = "Should a failed upload retry with exponential backoff or at a fixed interval?"
      const typed = "Any progress on the flaky upload test?"
      const w = await t.worker("stands", [
        {
          name: "arms a timer and asks", on: FIRST,
          tools: [{ command: `frizzctl timer set --in-seconds ${TIMER_S} --prompt 'Check whether the nightly build finished'`, description: "Set a timer" }],
          text: `The retry policy is the open call.\n\n${choice("retry-policy", question, ["Exponential backoff", "Fixed interval"])}`,
        },
        { name: "woken by its timer, says nothing of the question", on: TIMER_TRAILER, text: "The nightly build finished green; nothing changes for the retry work." },
        { name: "answers the human without the question", on: typed, text: "Not yet: the upload test still fails one run in five." },
        { name: "answers the reminder with a reference", on: SIGNOFF_NUDGE_MARKER, tools: [t.hold("reference")], text: `Still waiting on the retry policy.\n\n${fence("id: retry-policy")}` },
        { name: "hears the answer and signs off", on: BURIED_ANSWERS_HEADER, text: "Exponential backoff it is.\n\n```done\n- **Upload retries use exponential backoff.**\n```" },
      ])
      const rest1 = await w.restAfter(await w.start(FIRST))
      const timerSet = w.tool("frizzctl timer set")
      t.check("the worker's own `frizzctl timer set` armed a timer", timerSet?.exitCode === 0 && /tmr_/.test(timerSet.output), timerSet?.output.split("\n")[0])
      const asked = await until("the question on the board", async () => {
        const thread = await w.board()
        return thread?.questions?.length === 1 ? thread : undefined
      }, BOARD_MS)
      const id = asked.questions[0].id
      t.check("asked: standing, and the thread queues", asked.questions[0].standing === true && asked.needsYou === true)

      // A Frizz wake for something else, and a rest that does not reference the question.
      const timer = await w.start(TIMER_TRAILER, { after: rest1.index, timeoutMs: TIMER_S * 1000 + WAKE_MS, what: "the timer" })
      t.note(`timer reached the worker ${secs(Date.parse(timer.at) - Date.parse(rest1.at))} after the rest that armed it (set for ${TIMER_S}s, the shortest a timer may be, and fired by the tick after that)`)
      t.check("the timer arrives as a wake", timer.wake)
      const rest2 = await w.restAfter(timer)
      const acrossWake = await w.settled(rest2)
      const q2 = acrossWake.questions.find((q) => q.id === id)
      t.check("after the timer's turn, which never mentions it, the question still stands", q2?.standing === true, `standing ${q2?.standing}`)
      t.check("…and the thread still queues on it", acrossWake.needsYou === true)
      await sleep(TICK_MS + TAILER_MS)
      const tickLater = await w.board()
      t.check("…and a tick later nothing has changed, with no reminder sent", tickLater.questions.find((q) => q.id === id)?.standing === true && w.count(SIGNOFF_NUDGE_MARKER) === 0)

      // The human types; the worker replies past the question.
      await api.mutate("followUp", { slug: w.slug, sessionId: w.sessionId, message: typed })
      const human = await w.start(typed, { after: rest2.index })
      t.check("the human's message reaches the worker as a typed message, not a wake", !human.wake)
      const rest3 = await w.restAfter(human)
      // The reminder that bare rest earns is held open, so the faded state can be read.
      const reminder = await w.start(SIGNOFF_NUDGE_MARKER, { after: rest3.index, timeoutMs: WAKE_MS, what: "the sign-off reminder" })
      t.note(`sign-off reminder reached the worker ${secs(Date.parse(reminder.at) - Date.parse(rest3.at))} after the bare rest`)
      const faded = await until("the faded question on the board", async () => {
        const thread = await w.board()
        return thread?.questions?.find((q) => q.id === id)?.standing === false ? thread : undefined
      }, BOARD_MS).catch(() => w.board())
      const q3 = faded.questions.find((q) => q.id === id)
      t.check("once the human has typed past it the question no longer stands", q3?.standing === false, `standing ${q3?.standing}`)
      t.check("…and is still open, on the board, with its row unchanged", q3 !== undefined && w.questions()[0].state === "open" && w.questions()[0].id === id)
      t.check("the reminder, a Frizz wake, does not restore it", (await w.board()).questions.find((q) => q.id === id)?.standing === false)

      // A reference fence in a later reply.
      w.release("reference")
      const rest4 = await w.restAfter(reminder)
      const referenced = await w.settled(rest4)
      const q4 = referenced.questions.find((q) => q.id === id)
      t.check("a reference fence (`id:` alone) in a later reply makes it stand again", q4?.standing === true, `standing ${q4?.standing}`)
      t.check("…the thread queues on it, and it is the same row asked when it was", referenced.needsYou === true && q4?.askedAt === asked.questions[0].askedAt && w.questions().length === 1)

      // Still answerable, like any other.
      const answeredAt = Date.now()
      const answer = await api.mutate("answerQuestions", { slug: w.slug, answers: [{ questionId: id, question, chosen: ["Exponential backoff"] }] })
      t.check("it is answered through the card like any other", answer.answered.includes(id))
      const wake = await w.start(BURIED_ANSWERS_HEADER, { after: rest4.index, timeoutMs: KICK_MS, what: "the answer" })
      t.note(`answer reached the worker ${secs(Date.parse(wake.at) - answeredAt)} after the RPC`)
      const rest5 = await w.restAfter(wake)
      const done = await w.settled(rest5)
      t.check("…and the thread signs off with nothing open", done.questions.length === 0 && done.lastFence?.kind === "done")
      await w.quiet()
      t.check("one reminder in all: the bare rest after the human typed", w.count(SIGNOFF_NUDGE_MARKER) === 1, `${w.count(SIGNOFF_NUDGE_MARKER)} reminders`)
      t.check("no correction was ever sent", w.count(QUESTION_FENCE_CORRECTION_LEAD) === 0)
    },
  },

  {
    key: "D",
    title: "an autonomous thread: the question is cancelled on the record, a secret still asks",
    async run(t) {
      const goal = "Keep the migration moving until every table is copied; decide whatever can be decided."
      const targetQ = "Should the migration run against staging first or straight on production?"
      const tokenQ = "The deploy token for the staging environment"
      const w = await t.worker("goal", [
        { name: "asks, with a Goal armed", on: FIRST, tools: [t.hold("armed")], text: `One call before the copy starts.\n\n${choice("deploy-target", targetQ, ["Staging first", "Straight on production"])}` },
        { name: "hears the cancellation, decides, asks for a secret", on: CANCELLED, text: `Going with staging first; production follows once the copy verifies.\n\n${fence("id: deploy-token", "kind: secret", `question: ${tokenQ}`)}` },
        { name: "answers the Goal over the open secret", on: GOAL_TRAILER, times: 4, text: `Nothing else can move until the token arrives.\n\n${fence("id: deploy-token")}` },
      ])
      const first = await w.start(FIRST)
      // Armed the way the Goal panel arms it, while the first turn is still running.
      await api.mutate("setThreadRecurringPrompt", { slug: w.slug, sessionId: w.sessionId, prompt: goal, stopHook: true, heartbeat: false })
      const armed = await until("the Goal on the board", async () => ((await w.board())?.recurringPrompt ? w.board() : undefined), BOARD_MS)
      t.check("the Goal is armed at rest, as the panel arms it", armed.recurringPrompt.stopHook === true && sql(`SELECT recurring_on_rest r FROM session WHERE slug = ${quote(w.slug)}`)[0]?.r === 1, JSON.stringify(armed.recurringPrompt).slice(0, 120))
      w.release("armed")
      const rest1 = await w.restAfter(first)

      const cancel = await w.start(CANCELLED, { after: rest1.index, timeoutMs: WAKE_MS, what: "the cancellation" })
      t.note(`cancellation reached the worker ${secs(Date.parse(cancel.at) - Date.parse(rest1.at))} after the rest that asked`)
      t.check("the cancellation arrives as a wake", cancel.wake && /^1 question you registered was CANCELLED/.test(cancel.text))
      t.check("…naming the question by the worker's id and its text", cancel.text.includes("`deploy-target`") && cancel.text.includes(targetQ), cancel.text.split("\n").find((l) => l.startsWith("- ")))
      const target = w.questions().filter((r) => r.handle === "deploy-target")
      t.check("one row for it, dismissed", target.length === 1 && target[0].state === "dismissed", target.map((r) => r.state).join(", "))

      const rest2 = await w.restAfter(cancel)
      const asking = await until("the secret on the board", async () => {
        const thread = await w.board()
        return thread?.questions?.some((q) => q.spec.handle === "deploy-token") ? thread : undefined
      }, BOARD_MS)
      const token = asking.questions.find((q) => q.spec.handle === "deploy-token")
      t.note(`secret registered ${secs(Date.now() - Date.parse(rest2.at))} after the rest`)
      t.check("the board lists the cancelled question under closedQuestions", asking.closedQuestions?.some((c) => c.handle === "deploy-target" && c.state === "dismissed") === true, JSON.stringify(asking.closedQuestions))
      t.check("…and not as an open question or a fault", !asking.questions.some((q) => q.spec.handle === "deploy-target") && !asking.questionFaults?.length, JSON.stringify(asking.questionFaults))
      t.check("a `kind: secret` question on the same thread still asks", token?.spec.secret === true && w.questions().find((r) => r.handle === "deploy-token")?.state === "open")
      t.check("…standing, and the thread queues on it", token?.standing === true && asking.needsYou === true, `standing ${token?.standing}, needsYou ${asking.needsYou}`)

      // Stand the Goal down (both triggers off is the panel's off state), so the thread stops being prompted.
      await sleep(TICK_MS + TAILER_MS)
      const goalRows = w.deliveries().filter((d) => d.fence_id.startsWith("stophook:"))
      await api.mutate("setThreadRecurringPrompt", { slug: w.slug, sessionId: w.sessionId, prompt: goal, stopHook: false, heartbeat: false })
      await w.quiet()
      // Not asserted, because it is the outbox's quiet window at work and not this feature: the Goal's own
      // prompt for the rest that asked the secret is queued, and held five minutes behind the cancellation.
      t.note(`while armed, the Goal prompted the thread over its open secret ${w.count(GOAL_TRAILER)} time(s)${goalRows.length ? `; its prompt for that rest was ${goalRows.map((d) => `${d.state}, due ${secs(d.next_attempt_at - d.created_at)} after it was queued`).join("; ")}` : ""}`)
      t.check("exactly one cancellation wake", w.count(CANCELLED) === 1, `${w.count(CANCELLED)} in the transcript`)
      t.check("no correction for the question Frizz cancelled", w.count(QUESTION_FENCE_CORRECTION_LEAD) === 0 && !w.deliveries().some((d) => d.fence_id.startsWith("park:question-fence:")))
      const rows = w.questions()
      t.check("two rows in all: the dismissed question and the open secret", rows.length === 2 && rows.filter((r) => r.state === "dismissed").length === 1 && rows.filter((r) => r.state === "open").length === 1, rows.map((r) => `${r.handle} ${r.state}`).join(", "))
      t.check("the cancellation is marked delivered", rows.find((r) => r.handle === "deploy-target")?.delivered === 1)
    },
  },

  {
    key: "E",
    title: "the commands, run by the worker itself",
    async run(t) {
      const levelQ = "Should the server log at info or at debug by default?"
      const typed = "Wrap this up; the default is fine."
      const body = "- **Log level left at the default**; nothing else changed."
      const w = await t.worker("commands", [
        {
          name: "asks, with a follow-up", on: FIRST,
          text: ["The default log level is the open call.", choice("log-level", levelQ, ["Info", "Debug"]), choice("log-file", "Where should the debug log be written?", ["Beside the server log", "A file of its own"], ["when: log-level = Debug"])].join("\n\n"),
        },
        {
          name: "runs the commands", on: typed,
          tools: [
            { command: `frizzctl done --body ${quote(body)}`, description: "Sign off with the question open" },
            { command: "frizzctl unask log-file", description: "Withdraw the follow-up" },
            { command: `frizzctl ask ${quote(JSON.stringify({ questions: [{ question: levelQ, kind: "question", options: [{ label: "Info" }, { label: "Debug" }] }] }))}`, description: "Ask with the retired command" },
            { command: "frizzctl unask log-level", description: "Withdraw the question" },
            { command: `frizzctl done --body ${quote(body)}`, description: "Sign off" },
          ],
          text: "Wrapped up: the log level stays at the default.",
        },
      ])
      const rest1 = await w.restAfter(await w.start(FIRST))
      await until("the question on the board", async () => (await w.board())?.questions?.length === 1, BOARD_MS)
      await api.mutate("followUp", { slug: w.slug, sessionId: w.sessionId, message: typed })
      const rest2 = await w.restAfter(await w.start(typed, { after: rest1.index }), TURN_MS + 20_000)
      const [refused, followUp, ask, unask, accepted] = w.tools()
      const line = (c) => c?.output.replace(/^Exit code \d+\n/, "").split("\n")[0]

      t.check("`frizzctl done` with its question open is refused: exit 2", refused?.exitCode === 2, `exit ${refused?.exitCode} — ${line(refused)}`)
      t.check("…naming the question by the worker's own id", /^\s+log-level\s/m.test(refused?.output ?? "") && !/qst_/.test(refused?.output ?? ""), (refused?.output ?? "").split("\n").find((l) => l.includes("log-level")))
      t.check("`frizzctl unask <a follow-up's id>` withdraws nothing", /Nothing was withdrawn/.test(followUp?.output ?? ""), `exit ${followUp?.exitCode} — ${line(followUp)}`)
      t.check("…and names the root to withdraw instead", (followUp?.output ?? "").includes("`frizzctl unask log-level`"))
      t.check("`frizzctl ask` refuses: exit 2", ask?.exitCode === 2 && /NOT registered/.test(ask.output), `exit ${ask?.exitCode} — ${line(ask)}`)
      t.check("…and prints a fence to write instead", (ask?.output ?? "").includes("```question\nid: "))
      t.check("`frizzctl unask <id>` withdraws it", unask?.exitCode === 0 && /Question log-level withdrawn/.test(unask.output), `exit ${unask?.exitCode} — ${line(unask)}`)
      t.check("…and `frizzctl done` is then accepted", accepted?.exitCode === 0 && /^Marked done/.test(accepted.output), `exit ${accepted?.exitCode} — ${line(accepted)}`)

      const done = await w.settled(rest2)
      const rows = w.questions()
      t.check("one row, withdrawn, and `ask` registered nothing", rows.length === 1 && rows[0].state === "withdrawn", rows.map((r) => `${r.handle ?? r.id} ${r.state}`).join(", "))
      t.check("the board shows the thread done, with no open question", done.lastFence?.kind === "done" && done.questions.length === 0, `lastFence ${done.lastFence?.kind}`)
      t.check("…and the withdrawn question under closedQuestions", done.closedQuestions?.some((c) => c.handle === "log-level" && c.state === "withdrawn") === true)
      await sleep(TICK_MS + TAILER_MS)
      t.check("the registered done signs the rest: no reminder, no correction", w.count(SIGNOFF_NUDGE_MARKER) === 0 && w.count(QUESTION_FENCE_CORRECTION_LEAD) === 0)
    },
  },

  {
    key: "G",
    title: "a second broken fence in a row is corrected as promptly as the first",
    async run(t) {
      const question = "How deep should the upload queue be allowed to grow?"
      const w = await t.worker("twice", [
        { name: "asks with a fence that has no kind", on: FIRST, text: `The queue depth is the open call.\n\n${fence("id: queue-depth", `question: ${question}`, "options:", "  - label: 100 items", "  - label: 1000 items")}` },
        { name: "writes it again, still broken", on: QUESTION_FENCE_CORRECTION_LEAD, text: `With its kind this time.\n\n${fence("id: queue-depth", "kind: choice", `question: ${question}`, "options:", "  - label: 100 items")}` },
        { name: "writes it a third time, corrected", on: QUESTION_FENCE_CORRECTION_LEAD, text: `With both options.\n\n${choice("queue-depth", question, ["100 items", "1000 items"])}` },
      ])
      const rest1 = await w.restAfter(await w.start(FIRST))
      const first = await w.start(QUESTION_FENCE_CORRECTION_LEAD, { after: rest1.index, timeoutMs: WAKE_MS, what: "the first correction" })
      t.note(`first correction reached the worker ${secs(Date.parse(first.at) - Date.parse(rest1.at))} after its rest`)
      const rest2 = await w.restAfter(first)
      // The second correction follows a wake Frizz handed this thread seconds ago. It answers the worker's
      // own rest, exactly as the first did, so the outbox's quiet window must not hold it.
      const second = await w.start(QUESTION_FENCE_CORRECTION_LEAD, { after: rest2.index, timeoutMs: WAKE_MS, what: "the second correction" }).catch(() => undefined)
      const held = w.deliveries().find((d) => d.fence_id === `park:question-fence:${rest2.at}`)
      t.check("the second correction reaches the worker within a tick or two of its rest", second !== undefined,
        second ? undefined : held ? `still ${held.state} ${secs(Date.now() - Date.parse(rest2.at))} after the rest; the outbox holds it until ${new Date(held.next_attempt_at).toISOString()}, ${secs(held.next_attempt_at - held.created_at)} after it was queued` : "never queued")
      if (!second) return
      t.note(`second correction reached the worker ${secs(Date.parse(second.at) - Date.parse(rest2.at))} after its rest`)
      t.check("…naming the new fault, not the one already fixed", second.text.includes("`queue-depth`") && !second.text.includes("no `kind:`"), second.text.split("\n").find((l) => l.startsWith("- ")))
      const rest3 = await w.restAfter(second)
      const after = await w.settled(rest3)
      t.check("the third try registers and the thread queues on it", after.questions.length === 1 && after.questions[0].spec.handle === "queue-depth" && after.needsYou === true)
      t.check("…with no fault left on the board", !after.questionFaults?.length, JSON.stringify(after.questionFaults))
      await w.quiet()
      t.check("two corrections in all, one per broken rest", w.count(QUESTION_FENCE_CORRECTION_LEAD) === 2, `${w.count(QUESTION_FENCE_CORRECTION_LEAD)} in the transcript`)
      t.check("the allowance came back when the fence registered", sql(`SELECT park_bumps b FROM session WHERE slug = ${quote(w.slug)}`)[0]?.b === 0)
    },
  },

  {
    key: "F",
    title: "a restart mid-wait: the correction is delivered once, the rows are unchanged",
    restarts: true,
    async run(t) {
      const typed = "Also decide the instance tier before the rollout."
      const w = await t.worker("restart", [
        { name: "asks", on: FIRST, text: `The region is the first call.\n\n${choice("region", "Which region should the service deploy to first?", ["us-east", "eu-west"])}` },
        {
          name: "asks a second question with a broken fence", on: typed, tools: [t.hold("go")],
          text: `The tier is open too; the region still is.\n\n${fence("id: region")}\n\n${fence("id: tier", "question: Which instance tier should the service run on?", "options:", "  - label: Standard", "  - label: Large")}`,
        },
        { name: "writes the second fence again, corrected", on: QUESTION_FENCE_CORRECTION_LEAD, text: `The tier fence was missing its kind.\n\n${choice("tier", "Which instance tier should the service run on?", ["Standard", "Large"])}` },
      ])
      // A second thread, for the other side of the stop: its correction is SENT before the server goes
      // down, and its worker is still thinking about it when the new server comes up and the old one's
      // confirmation window runs out.
      const zoneQ = "Which availability zone should hold the primary?"
      const v = await t.worker("sent", [
        { name: "asks with a fence that has no kind", on: FIRST, text: `The zone is the open call.\n\n${fence("id: zone", `question: ${zoneQ}`, "options:", "  - label: Zone A", "  - label: Zone B")}` },
        { name: "writes it again, corrected, after thinking through the restart", on: QUESTION_FENCE_CORRECTION_LEAD, think: SLOW_TURN_MS, text: `The zone fence was missing its kind.\n\n${choice("zone", zoneQ, ["Zone A", "Zone B"])}` },
      ])
      const rest1 = await w.restAfter(await w.start(FIRST))
      await until("the first question on the board", async () => (await w.board())?.questions?.length === 1, BOARD_MS)
      const before = w.questions()
      const vRest = await v.restAfter(await v.start(FIRST))
      const vCorrection = await v.start(QUESTION_FENCE_CORRECTION_LEAD, { after: vRest.index, timeoutMs: WAKE_MS, what: "the correction, before the stop" })
      await api.mutate("followUp", { slug: w.slug, sessionId: w.sessionId, message: typed })
      const human = await w.start(typed, { after: rest1.index })

      // Stop the server the moment the broken rest is on disk — before the tick that would correct it.
      const stack = stackProcess()
      if (!stack.keeps) {
        t.check("the stack keeps its HOME across a stop", false, "boot it with --keep (or --home=…): stopping this one would delete the HOME under test")
        w.release("go")
        return
      }
      w.release("go")
      const rest2 = await w.restAfter(human)
      process.kill(stack.pid, "SIGTERM")
      const killedAt = Date.now()
      await until("the server process exiting", () => !alive(stack.pid), 20_000)
      t.note(`server (pid ${stack.pid}) stopped ${secs(killedAt - Date.parse(rest2.at))} after the broken rest reached the transcript; gone ${secs(Date.now() - killedAt)} later`)
      const queuedBefore = w.deliveries().filter((d) => d.fence_id.startsWith("park:question-fence:"))
      t.check("stopped with the correction not yet delivered", queuedBefore.every((d) => d.sent_at === null) && w.count(QUESTION_FENCE_CORRECTION_LEAD) === 0, queuedBefore.length === 0 ? "not even queued: the scheduler had not ticked" : queuedBefore.map((d) => d.state).join(", "))
      t.note(queuedBefore.length === 0 ? "the correction was not queued when the server stopped — the new process has to find the fault itself" : "the correction was queued but unsent when the server stopped")
      t.check("…and the first question's row as it was", JSON.stringify(w.questions()) === JSON.stringify(before))
      const brokers = sessionProcesses(w.sessionId)
      t.check("the worker process, under its broker daemon, outlives the server", brokers.length > 0, `${brokers.length} process(es) still carry its session id`)

      const bootAt = Date.now()
      const restarted = await restartStack(stack)
      t.note(`server booted again as pid ${restarted.pid} in ${secs(Date.now() - bootAt)} — kill THAT pid when done`)
      const correction = await w.start(QUESTION_FENCE_CORRECTION_LEAD, { after: rest2.index, timeoutMs: WAKE_MS + TICK_MS, what: "the correction, after the restart" })
      t.note(`correction reached the worker ${secs(Date.parse(correction.at) - bootAt)} after the boot began (${secs(Date.parse(correction.at) - Date.parse(rest2.at))} after its rest)`)
      t.check("after the restart the correction is delivered, to the daemon the old server forked", correction.wake && correction.text.includes("`tier`") && sessionProcesses(w.sessionId).some((p) => brokers.some((b) => b.pid === p.pid)))
      t.check("…and it names only the broken fence, not the reference beside it", !correction.text.includes("`region`"), correction.text.split("\n").filter((l) => l.startsWith("- ")).join(" | "))
      const rest3 = await w.restAfter(correction)
      const after = await w.settled(rest3)
      const region = after.questions.find((q) => q.spec.handle === "region")
      const tier = after.questions.find((q) => q.spec.handle === "tier")
      t.check("the fix registers", tier !== undefined && tier.askedAt === rest3.at, `${tier?.askedAt} vs ${rest3.at}`)
      t.check("the first question's row is byte-identical across the restart", JSON.stringify(w.questions().find((r) => r.handle === "region")) === JSON.stringify(before[0]))
      t.check("…and it still stands, by the reference written before the stop", region?.standing === true && after.needsYou === true, `standing ${region?.standing}`)
      t.check("the board lists no fault any more", !after.questionFaults?.length, JSON.stringify(after.questionFaults))

      await w.quiet()
      t.check("the correction was delivered once, not twice", w.count(QUESTION_FENCE_CORRECTION_LEAD) === 1, `${w.count(QUESTION_FENCE_CORRECTION_LEAD)} in the transcript`)
      const corrections = w.deliveries().filter((d) => d.fence_id.startsWith("park:question-fence:"))
      t.check("…from one outbox row", corrections.length === 1, corrections.map((d) => `${d.fence_id} ${d.state}`).join(", "))
      t.check("two rows, both open", w.questions().length === 2 && w.questions().every((r) => r.state === "open"))

      // The thread whose correction the OLD server sent. Its worker answers only after that wake's
      // confirmation window has run out under the NEW server, which must settle it and not send it again.
      const vRest2 = await v.restAfter(vCorrection, SLOW_TURN_MS + TURN_MS)
      t.note(`the other thread's worker answered its correction ${secs(Date.parse(vRest2.at) - Date.parse(vCorrection.at))} after receiving it, ${secs(Date.parse(vRest2.at) - bootAt)} into the new server's life`)
      const vAfter = await v.settled(vRest2)
      t.check("a correction sent before the stop is answered after it, and the fix registers", vAfter.questions.length === 1 && vAfter.questions[0].spec.handle === "zone" && vAfter.questions[0].askedAt === vRest2.at)
      await v.quiet()
      const vRows = v.deliveries().filter((d) => d.fence_id.startsWith("park:question-fence:"))
      t.check("…and the new server did not send it a second time", v.count(QUESTION_FENCE_CORRECTION_LEAD) === 1 && vRows.length === 1 && vRows[0].attempts === 1, `${v.count(QUESTION_FENCE_CORRECTION_LEAD)} in the transcript; ${vRows.map((d) => `${d.state}, ${d.attempts} attempt(s)`).join("; ")}`)
      t.note(`its outbox row, sent by the old server, was settled by the new one as ${vRows[0]?.state}`)
    },
  },
]

// ---- the stack, for the case that restarts it -----------------------------------------------------------

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The server process behind this HOME, and the arguments it was booted with. */
function stackProcess() {
  const { pid } = JSON.parse(readFileSync(join(home, ".frizz", "server.lock"), "utf8"))
  const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)]).toString().trim()
  const at = command.indexOf("adhoc-stack.mjs")
  if (at < 0) throw new Error(`pid ${pid} (from server.lock) is not an adhoc stack: ${command.slice(0, 120)}`)
  const args = command.slice(at + "adhoc-stack.mjs".length).trim().split(/\s+/).filter(Boolean)
  return { pid, args, keeps: args.some((a) => a === "--keep" || a.startsWith("--home=")) }
}

/** The processes carrying a session id on their command line: the scripted worker under its broker daemon. */
function sessionProcesses(sessionId) {
  return execFileSync("ps", ["-Ao", "pid=,command="]).toString().split("\n").filter((l) => l.includes(sessionId)).map((l) => ({ pid: Number(l.trim().split(/\s+/)[0]), command: l.trim() }))
}

/** Boot the stack again on the same HOME, with the arguments it had, detached from this process. */
async function restartStack(stack) {
  const args = [...stack.args.filter((a) => a !== "--keep" && !a.startsWith("--home=") && !a.startsWith("--project=")), `--home=${home}`, `--project=${cwd}`]
  const out = openSync(join(scratch, `stack-restart-${run}.log`), "a")
  const child = spawn("nub", [join(repoRoot, "scripts", "adhoc-stack.mjs"), ...args], {
    cwd: repoRoot, detached: true, stdio: ["ignore", out, out],
    env: { ...process.env, ...(log ? { FRIZZ_LOG_PATH: log } : {}) },
  })
  child.unref()
  api = createRpcClient(`http://127.0.0.1:${port}/`, project.id)
  if (!(await api.waitForHealth(60_000))) throw new Error(`the stack did not come back; see ${join(scratch, `stack-restart-${run}.log`)}`)
  const { pid } = JSON.parse(readFileSync(join(home, ".frizz", "server.lock"), "utf8"))
  return { pid }
}

// ---- run -------------------------------------------------------------------------------------------------

const only = flags.only ? new Set(flags.only.toUpperCase().split(",")) : undefined
const skip = new Set((flags.skip ?? "").toUpperCase().split(",").filter(Boolean))
const chosen = CASES.filter((c) => (only ? only.has(c.key) : true) && !skip.has(c.key))
if (chosen.length === 0) {
  console.error(`no case matches — the cases are ${CASES.map((c) => c.key).join(", ")}\n${USAGE}`)
  process.exit(1)
}

async function runCase(c) {
  const t = caseContext(c.key)
  const startedAt = Date.now()
  try {
    await c.run(t)
    expectScripted(t)
  } catch (error) {
    t.check(`case ${c.key} ran to its end`, false, error instanceof Error ? error.message : String(error))
  }
  return { c, t, ms: Date.now() - startedAt }
}

function report({ c, t, ms }) {
  console.log(`\n── ${c.key}. ${c.title} (${secs(ms)}) ──`)
  for (const line of t.lines) console.log(line)
  if (t.failures === 0) return
  // Every FAIL is a finding: what the worker saw and said, what the outbox held, what the server logged.
  for (const w of t.workers) evidence(w)
}

function evidence(w) {
  try {
    console.log(`\n      transcript of ${w.slug} (${w.path}):`)
    for (const line of w.digest()) console.log(`      ${line}`)
    console.log(`      outbox rows of ${w.slug}:`)
    for (const d of w.deliveries()) console.log(`        ${new Date(d.created_at).toISOString()}  ${d.state.padEnd(10)} sent ${d.sent_at ? new Date(d.sent_at).toISOString() : `never (due ${new Date(d.next_attempt_at).toISOString()})`}  ${d.fence_id}  — ${d.reason}${d.last_error ? `  [${d.last_error}]` : ""}`)
    console.log(`      question rows of ${w.slug}:`)
    for (const r of w.questions()) console.log(`        ${r.id}  ${String(r.handle).padEnd(16)} ${r.state.padEnd(9)} asked ${new Date(r.asked_at).toISOString()} delivered ${r.delivered}`)
    if (log && existsSync(log)) {
      console.log(`      server log lines naming ${w.slug}:`)
      for (const line of readFileSync(log, "utf8").split("\n").filter((l) => l.includes(w.slug) && !/\bDEBUG\b/.test(l)).slice(-40)) console.log(`        ${line.slice(0, 260)}`)
    }
  } catch (error) {
    console.log(`      (the evidence for ${w.slug} could not be read: ${error instanceof Error ? error.message.split("\n")[0] : String(error)})`)
  }
}

console.log(`stack http://127.0.0.1:${port} (HOME ${home}); project ${cwd}; a tick is ${secs(TICK_MS)}`)
// The cases share nothing but the server, so they run side by side; the one that restarts it runs alone, last.
const together = chosen.filter((c) => !c.restarts)
const alone = chosen.filter((c) => c.restarts)
if (together.length > 0) console.log(`running ${together.map((c) => c.key).join(", ")} ${"serial" in flags ? "one at a time" : "side by side"}…`)
const results = []
if ("serial" in flags) {
  for (const c of together) {
    const r = await runCase(c)
    results.push(r)
    report(r)
  }
} else {
  results.push(...(await Promise.all(together.map(runCase))))
  for (const r of results) report(r)
}
for (const c of alone) {
  console.log(`\nrunning ${c.key} (it restarts the stack)…`)
  const r = await runCase(c)
  results.push(r)
  report(r)
}

const failures = results.reduce((n, r) => n + r.t.failures, 0)
const mine = execFileSync("ps", ["-Ao", "pid=,command="]).toString().split("\n").filter((l) => results.some((r) => r.t.workers.some((w) => l.includes(w.sessionId))))
console.log(`\n${mine.length} worker process(es) of this run are still alive (detached broker sessions; kill each by pid, and its parent daemon):`)
for (const line of mine) console.log(`  ${line.trim().slice(0, 140)}`)
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
