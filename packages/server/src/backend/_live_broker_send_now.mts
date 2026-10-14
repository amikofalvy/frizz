// LIVE PROBE: does "send now" get a message read at once WITHOUT killing the call it arrived under?
//   nub packages/server/src/backend/_live_broker_send_now.mts [arm[:runs] ...]
//
// WHY. "Send now" (⌘⏎, the ↑ beside a queued bubble) used to be a plain interrupt: the running tool
// call was killed, Claude Code answered it with its stock rejection paragraph ("The user doesn't want
// to proceed with this tool use … STOP what you are doing"), and the worker had to work out that
// nothing had been rejected and run the call again (_live_broker_interrupt_cut_call.mts). The runtime
// has a send-now of its own: asked to push a waiting message through, it moves the call the turn is
// waiting on to the background and folds the message into the same turn. Frizz now asks for that
// (ClaudeInterruptOptions), and this is the proof that it gets it, through a real broker daemon.
//
// THE DIFFERENTIAL, one variable. Every run is its own real broker session with the same task: a 45s
// foreground build that leaves BUILD.txt, then a step that needs it. 6s in, a remark is delivered
// exactly as the bridge delivers one — acknowledged input, then the interrupt frame, back to back.
//   send-now — the message says a person typed it; the frame asks for a send-now naming it
//   plain    — the same message; a bare interrupt frame (what every send-now was before 2026-10-13)
//   unsigned — a send-now for a message that does NOT say a person typed it
//
// WHAT MUST HOLD for `send-now`, and is asserted per run:
//   · the build is not killed and not run twice: one Bash call, and BUILD.txt lands ~45s after it began
//   · no result carries the rejection paragraph, and the call's result says it was moved aside
//   · the worker answers the remark BEFORE the build finishes — it was read now, not at the boundary
//   · the daemon recorded the runtime's own verdict, `delivering` (it is `nothing_waiting` when the
//     request overtakes the message it names, and then nothing above holds either)
// `plain` and `unsigned` are the negative controls: both abort the turn, so both must show the
// rejection paragraph — a probe that cannot see it fail proves nothing about the arm that passes.
//
// MEASURED 2026-10-13, Claude Code 2.1.296 / SDK 0.3.296, Opus. `send-now`, 3 of 3: the verdict was
// `delivering`, the build was called once and left BUILD.txt 45.2-45.3s after it began, and the remark
// was answered 2.5-4.0s after the send, each worker then resting on the moved shell. `plain` and
// `unsigned`, 1 of 1 each: the turn was aborted, the call got the rejection paragraph and the build
// was called twice (`unsigned` answered `stopped`). Before the adapter waited for its input queue to
// drain, the request overtook the message in 4 of 4 raw-SDK runs and answered `nothing_waiting`.
import { execFileSync } from "node:child_process"
import { mkdtempSync, existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { forkBroker, killBroker } from "./claude-broker-host.ts"
import { connectClaudeBroker } from "./claude-broker-client.ts"
import { readClaudeBrokerDiagnostics } from "./claude-broker-diagnostics.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"
import { buildWorkerPrompt } from "../workerPrompt.ts"

type Arm = "send-now" | "plain" | "unsigned"
const ARMS: Arm[] = ["send-now", "plain", "unsigned"]

const BUILD_SECONDS = 45
// NOT a bare `sleep`: Claude Code's own tool policy refuses one (see _live_broker_interrupt_send.mts).
const TASK =
  `Use the Bash tool ONCE, in the foreground with a timeout of 120000ms, to run exactly: python3 -c "import time; time.sleep(${BUILD_SECONDS}); open('BUILD.txt','w').write('ok')" ` +
  `— that is this repo's build and it takes ${BUILD_SECONDS} seconds. Run nothing else first. When it has finished, write DONE.txt containing the contents of BUILD.txt, then reply FINISHED.`
const REMARK = "fyi the build is pretty slow on this machine today"
const REJECTED = "The user doesn't want to proceed with this tool use."
const MOVED = "was moved to the background"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
// The real HOME, deliberately: a live Claude under a sandbox HOME raises a keychain dialog (CLAUDE.md).
const env = Object.fromEntries(
  ["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"]
    .filter((k) => process.env[k]).map((k) => [k, process.env[k]!]),
)

interface Report {
  arm: string
  error?: string
  verdict: string
  builds: number
  rejected: boolean
  moved: boolean
  /** ms from the remark to the worker's first words after it; undefined ⇒ it never spoke. */
  answeredAfterMs?: number
  /** ms from the build's own start to BUILD.txt; undefined ⇒ the file never appeared. */
  buildTookMs?: number
  answeredBeforeBuildEnded: boolean
  done: boolean
}

// The session's own transcript is the record of what the worker was actually shown.
function transcriptOf(cwd: string, sessionId: string): Array<Record<string, any>> {
  const path = join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`)
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>)
  } catch { return [] }
}

async function run(arm: Arm, n: number): Promise<Report> {
  const tag = `${arm}#${n}`
  // NEUTRAL NAMES, the same for every arm: the worker reads its working directory.
  const stateDir = mkdtempSync(join(tmpdir(), "sample-state-"))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sample-repo-")))
  execFileSync("git", ["init", "-q", cwd])
  const sessionId = randomUUID()
  const t0 = Date.now()
  const log = (line: string) => console.log(`[${tag}] t+${String(Date.now() - t0).padStart(6)}ms ${line}`)
  let buildStartedAt: number | undefined
  let remarkAt: number | undefined
  let answeredAt: number | undefined
  let results = 0
  const report: Report = { arm: tag, verdict: "?", builds: 0, rejected: false, moved: false, answeredBeforeBuildEnded: false, done: false }
  const record = await forkBroker({
    stateDir, cwd, sessionId, executablePath: claudeBin, env, permissionMode: "bypassPermissions",
    model: process.env.PROBE_MODEL ?? "opus", appendSystemPrompt: buildWorkerPrompt("claude"),
  })
  const client = connectClaudeBroker(record.socketPath, {
    onEvent: (event: ClaudeQueryEvent) => {
      if (event.kind === "result") results++
      if (event.kind !== "assistant" || event.parentToolUseId !== undefined) return
      if (buildStartedAt === undefined && event.toolUses.some((t) => t.name === "Bash")) { buildStartedAt = Date.now(); log("the build is running") }
      const text = event.text.join(" ").replace(/\s+/g, " ").trim()
      if (remarkAt !== undefined && answeredAt === undefined && text) { answeredAt = Date.now(); log(`answered: ${JSON.stringify(text.slice(0, 160))}`) }
    },
    onPermissionRequest: (requestId) => client.answerPermission(requestId, { behavior: "allow" }),
    onDiagnostic: () => {},
  })
  const waitFor = async (pred: () => boolean, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms
    while (!pred()) {
      if (Date.now() > deadline) return false
      await new Promise((r) => setTimeout(r, 50))
    }
    return true
  }
  try {
    client.sendInput({ id: randomUUID(), text: TASK })
    if (!await waitFor(() => buildStartedAt !== undefined, 120_000)) throw new Error("the build never started")
    await new Promise((r) => setTimeout(r, 6_000))
    const id = randomUUID()
    // As the bridge does it: the input is acknowledged, then the frame goes out with nothing between.
    await client.deliverInput({ id, text: REMARK, ...(arm === "unsigned" ? {} : { human: true }) }, { acknowledged: true })
    client.interrupt(arm === "plain" ? undefined : { sendNow: { messageId: id } })
    remarkAt = Date.now()
    log(`remark + ${arm === "plain" ? "interrupt" : "send-now"}`)
    // Settled = DONE.txt, or two more turns have ended without it (the worker stopped and asked).
    const resultsAtRemark = results
    await waitFor(() => existsSync(join(cwd, "DONE.txt")) || results >= resultsAtRemark + 3, 150_000)

    const records = transcriptOf(cwd, sessionId)
    const blocks = records.flatMap((r) => Array.isArray(r.message?.content) ? r.message.content.map((b: any) => ({ type: r.type, sidechain: r.isSidechain === true, b })) : [])
    const resultTexts = blocks.filter((x) => x.b?.type === "tool_result").map((x) => typeof x.b.content === "string" ? x.b.content : Array.isArray(x.b.content) ? x.b.content.map((c: any) => c?.text ?? "").join("") : "")
    report.builds = blocks.filter((x) => !x.sidechain && x.b?.type === "tool_use" && x.b.name === "Bash" && String(x.b.input?.command ?? "").includes("time.sleep")).length
    report.rejected = resultTexts.some((t) => t.includes(REJECTED))
    report.moved = resultTexts.some((t) => t.includes(MOVED))
    report.done = existsSync(join(cwd, "DONE.txt"))
    const buildPath = join(cwd, "BUILD.txt")
    if (existsSync(buildPath) && buildStartedAt !== undefined) report.buildTookMs = Math.round(statSync(buildPath).mtimeMs - buildStartedAt)
    if (answeredAt !== undefined) report.answeredAfterMs = answeredAt - remarkAt
    report.answeredBeforeBuildEnded = answeredAt !== undefined && buildStartedAt !== undefined && answeredAt < buildStartedAt + BUILD_SECONDS * 1000
    report.verdict = readClaudeBrokerDiagnostics(stateDir, sessionId).map((d) => d.diagnostic.message ?? "").find((m) => m.startsWith("send-now:"))?.replace(/ id=.*/, "") ?? "(no send-now)"
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err)
  } finally {
    try { client.close() } catch {}
    try { killBroker(stateDir, sessionId) } catch {}
    // The daemon is still writing its last diagnostics as it dies; a busy directory is not a failure.
    await new Promise((r) => setTimeout(r, 500))
    try { rmSync(stateDir, { recursive: true, force: true }) } catch {}
    try { rmSync(cwd, { recursive: true, force: true }) } catch {}
    // The session folder Claude Code keeps for the throwaway repo, so a run leaves nothing behind.
    try { rmSync(join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true, force: true }) } catch {}
  }
  log(report.error ? `ERROR ${report.error}` : JSON.stringify({ ...report, arm: undefined }))
  return report
}

const specs = process.argv.slice(2).length ? process.argv.slice(2) : ["send-now:2", "plain:1", "unsigned:1"]
const jobs: Promise<Report>[] = []
for (const spec of specs) {
  const [arm, runs] = spec.split(":")
  if (!ARMS.includes(arm as Arm)) throw new Error(`unknown arm "${arm}" — ${ARMS.join(", ")}`)
  for (let i = 1; i <= Number(runs ?? 1); i++) jobs.push(run(arm as Arm, i))
}
const reports = await Promise.all(jobs)

console.log("\n──────── ANALYSIS ────────")
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
for (const r of reports) {
  if (r.error) { ok(`${r.arm} ran`, false, r.error); continue }
  const arm = r.arm.split("#")[0] as Arm
  const tolerance = 8_000
  if (arm === "send-now") {
    ok(`${r.arm}: the runtime moved the call aside`, r.verdict === "send-now: delivering" && r.moved, r.verdict)
    ok(`${r.arm}: no rejection paragraph`, !r.rejected)
    ok(`${r.arm}: the build ran once and finished on time`, r.builds === 1 && r.buildTookMs !== undefined && Math.abs(r.buildTookMs - BUILD_SECONDS * 1000) < tolerance, `${r.builds} call(s), BUILD.txt at ${r.buildTookMs}ms`)
    ok(`${r.arm}: the remark was answered before the build ended`, r.answeredBeforeBuildEnded, `${r.answeredAfterMs}ms after it was sent`)
    ok(`${r.arm}: the task was finished`, r.done)
  } else {
    // The controls: an abort, which is what shows the rejection paragraph and kills the build.
    ok(`${r.arm}: aborted the turn, as a control must`, r.rejected && !r.moved, `${r.verdict}; ${r.builds} build call(s), BUILD.txt at ${r.buildTookMs}ms, done=${r.done}`)
  }
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
