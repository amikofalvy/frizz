// Seed a disposable adhoc stack with SIMULATED workers in two or more projects — a few queued, a few
// snoozed and a page-and-a-half of Done in each — so the Console's "By status" bands (Queue, Snoozed,
// Done, and Done's "Show more" pages) can be judged in the real app. Written 2026-10-23 for the Console's
// Snoozed and Done bands.
//
// The seed-rail-bands.mjs recipe, per project: a broker-runtime session row, a broker liveness record
// and a JSONL the REAL tailer reads. A snooze is the row's own `snoozed_until`, and Done is `archived`
// with a staggered `archived_at`, the Done band's order key.
//
// Boot a stack with a tenant, then pass each project as <id>=<dir> from its json line:
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<repo a> --also-project=<repo b> > stack.log 2>&1
//   nub scripts/seed-console-bands.mjs --home=<home> --project=<launcher.id>=<launcher.dir> \
//     --project=<tenants[0].id>=<tenants[0].dir> [--done=14,9]
// It prints the pid of the one stand-in daemon every row points at; kill it with the stack.
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const args = process.argv.slice(2)
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const home = opt("home")
const projects = args.filter((a) => a.startsWith("--project=")).map((a) => {
  const [id, dir] = a.slice("--project=".length).split("=")
  return { id, dir }
})
const doneCounts = (opt("done") ?? "14,9").split(",").map(Number)
if (!home || projects.length === 0 || projects.some((p) => !p.id || !p.dir)) {
  console.error("usage: nub scripts/seed-console-bands.mjs --home=<home> --project=<id>=<dir> [--project=…] [--done=14,9]")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
// ONE stand-in daemon for every seeded thread — its only job is to own a pid that answers `kill -0`.
const daemon = spawn("sleep", ["7200"], { detached: true, stdio: "ignore" })
daemon.unref()

const T0 = Date.now() - 6 * 3_600_000
const at = (m) => new Date(T0 + m * 60_000).toISOString()
const LATER = new Date(Date.now() + 6 * 3_600_000).toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`
const sql = (v) => (v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`)

function seed(project, { slug, title, closing, minute, snoozedUntil = null, archivedAt = null }) {
  const { cols, vals } = sessionProjectColumns({ ...sandbox, projectId: project.id })
  const stateDir = join(home, ".frizz", "projects", project.id)
  const jsonlDir = join(home, ".claude", "projects", project.dir.replace(/[/.]/g, "-"))
  mkdirSync(jsonlDir, { recursive: true })
  mkdirSync(join(stateDir, "claude-broker"), { recursive: true })
  const sessionId = `${createHash("sha256").update(`${project.id}/${slug}`).digest("hex").slice(0, 8)}-0000-4000-9000-000000000000`
  const records = [
    { parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: at(minute), session_id: sessionId, cwd: project.dir, message: { role: "user", content: `TASK:\n${title}.` } },
    {
      parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: at(minute + 2), session_id: sessionId, cwd: project.dir,
      message: { model: "claude-opus-5", id: `msg_${slug}`, type: "message", role: "assistant", content: [{ type: "text", text: closing }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 40 } },
    },
  ]
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  const record = join(stateDir, "claude-broker", `${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.json`)
  writeFileSync(record, JSON.stringify({ sessionId, daemonPid: daemon.pid, socketPath: join(stateDir, "claude-broker", `${slug}.sock`) }))
  const archived = archivedAt !== null
  execFileSync("sqlite3", [
    sandbox.db,
    `INSERT OR REPLACE INTO session (${cols}slug, session_id, thread_name, spawned_at, title, backend, claude_runtime, model, effort, permission_mode, rested_at, archived, state, snoozed_until, archived_at)
     VALUES (${vals}${sql(slug)}, ${sql(sessionId)}, ${sql(`frizz-${slug}`)}, ${sql(at(minute))}, ${sql(title)}, 'claude', 'broker', 'opus', 'high', 'default', ${sql(at(minute + 2))}, ${archived ? 1 : 0}, ${sql(archived ? "archived" : "active")}, ${sql(snoozedUntil)}, ${sql(archivedAt)})`,
  ])
}

const QUEUED = ["Review the retry backoff", "Pick a name for the export flag", "Approve the schema migration"]
const SNOOZED = ["Watch the deploy error rate", "Re-run the quota estimator", "Check the nightly bench", "Follow up on the flaky upload"]
const DONE = [
  "Fix the cache collision", "Kill the tailer flake", "Align the composer icons", "Refactor the pricing parser",
  "Trim the Done band's render", "Rename the launch variable", "Document the release steps", "Pin the codex runtime",
  "Drop the legacy fence keys", "Shorten the toast copy", "Cap the running rows", "Sort Running by entry time",
  "Move the house link", "Repair the registry on boot", "Stop the keychain dialog", "Strip the add query",
]

projects.forEach((project, p) => {
  const queued = QUEUED.slice(0, p === 0 ? 2 : 1)
  const snoozed = SNOOZED.slice(p === 0 ? 0 : 2, p === 0 ? 2 : 4)
  const done = doneCounts[p] ?? doneCounts.at(-1)
  queued.forEach((title, i) => seed(project, { slug: `queued-${i}`, title, closing: "Done with the first pass; over to you.", minute: 300 + p * 7 + i }))
  snoozed.forEach((title, i) => seed(project, { slug: `snoozed-${i}`, title, closing: "Parked until later.", minute: 200 + p * 5 + i, snoozedUntil: LATER }))
  for (let i = 0; i < done; i++) {
    // Interleaved across projects, so the band mixes them as it would in life.
    const minute = 10 + i * 12 + p * 5
    seed(project, { slug: `done-${i}`, title: DONE[(i + p * 5) % DONE.length], closing: "Fixed and landed.", minute, archivedAt: at(minute + 3) })
  }
  console.log(`seeded ${project.id}: ${queued.length} queued, ${snoozed.length} snoozed, ${done} done`)
})
console.log(JSON.stringify({ daemonPid: daemon.pid }))
