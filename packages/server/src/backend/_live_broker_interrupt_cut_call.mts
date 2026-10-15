// LIVE PROBE: does a worker go back to the tool call "send now" cut off?
//   nub packages/server/src/backend/_live_broker_interrupt_cut_call.mts [arm[:runs] ...]
//
// WHY. "Send now" (⌘⏎, the Send now under the queued messages) interrupts the running turn so the worker reads a
// message at once (_live_broker_interrupt_send.mts). Claude Code answers the tool call that was in
// flight with the stock paragraph it uses for a real rejection — "The user doesn't want to proceed with
// this tool use. The tool use was rejected (…) STOP what you are doing and wait for the user to tell you
// how to proceed." — and Frizz cannot change that text. The worker contract carries a section saying
// what the paragraph is (workerPrompt.ts CLAUDE_INTERRUPTED_CALL); this measures whether it works.
//
// SINCE 2026-10-13 THIS IS THE FALLBACK. A send now asks for the runtime's own send-now first, which
// moves the running call to the background instead of cutting it (_live_broker_send_now.mts), so a
// worker reads the paragraph only when that request ends the turn anyway. This probe still sends the
// PLAIN interrupt on purpose: it is the one way to produce the paragraph every time.
//
// THE DIFFERENTIAL, one variable. Every arm is its own real broker session with the same task: a 45s
// foreground build, then a step that needs its output. 6s in, a message that says NOTHING about how to
// proceed is pushed through with an interrupt — the shape the corpus shows, a remark rather than an
// instruction. A worker that reads the paragraph as a rejection stops and asks; one that reads it as an
// interruption runs the build again and finishes (DONE.txt).
//   bare     — no contract at all
//   without  — the Claude worker contract with the section removed
//   contract — the Claude worker contract as built
//
// MEASURED 2026-10-13, Claude Code 2.1.296, Opus, 46 sessions: bare 3 of 3 stopped; without 4 of 24
// stopped, each asking the human how to re-run the build and saying the call was declined "before it
// started" (it had run for 6s); contract 0 of 19 stopped. The stall is INTERMITTENT — three of the four
// `without` stalls fell inside one minute and the next twenty runs produced one — so a small `without`
// run passing clean says nothing; it takes a couple of dozen to see the rate.
import { execFileSync } from "node:child_process"
import { mkdtempSync, existsSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { forkBroker, killBroker } from "./claude-broker-host.ts"
import { connectClaudeBroker } from "./claude-broker-client.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"
import { buildWorkerPrompt } from "../workerPrompt.ts"

type Arm = "bare" | "without" | "contract"

const SECTION = /\n\n## When a message cuts a tool call short\n[\s\S]*?(?=\n\n## )/
const contract = buildWorkerPrompt("claude")
const contractWithout = contract.replace(SECTION, "")
if (contractWithout === contract) throw new Error("the contract no longer carries the section this probe removes")
const systemPromptFor = (arm: Arm): string | undefined => (arm === "bare" ? undefined : arm === "without" ? contractWithout : contract)

// NOT a bare `sleep`: Claude Code's own tool policy refuses one (see _live_broker_interrupt_send.mts).
const TASK =
  'Use the Bash tool ONCE, in the foreground with a timeout of 120000ms, to run exactly: python3 -c "import time; time.sleep(45); open(\'BUILD.txt\',\'w\').write(\'ok\')" ' +
  "— that is this repo's build and it takes 45 seconds. Run nothing else first. When it has finished, write DONE.txt containing the contents of BUILD.txt, then reply FINISHED."
const REMARK = "fyi the build is pretty slow on this machine today"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
// The real HOME, deliberately: a live Claude under a sandbox HOME raises a keychain dialog (CLAUDE.md).
const env = Object.fromEntries(
  ["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"]
    .filter((k) => process.env[k]).map((k) => [k, process.env[k]!]),
)

async function run(arm: Arm, n: number): Promise<{ arm: string; resumed: boolean; said: string; error?: string }> {
  const tag = `${arm}#${n}`
  // NEUTRAL NAMES, the same for every arm: the worker reads its working directory, and a path that
  // names the arm or the experiment is a cue it can act on.
  const stateDir = mkdtempSync(join(tmpdir(), "sample-state-"))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sample-repo-")))
  execFileSync("git", ["init", "-q", cwd])
  const sessionId = randomUUID()
  const t0 = Date.now()
  const log = (line: string) => console.log(`[${tag}] t+${String(Date.now() - t0).padStart(6)}ms ${line}`)
  let toolUses = 0
  let results = 0
  let cutAt: number | undefined
  const said: string[] = []
  const report = { arm: tag, resumed: false, said: "" } as { arm: string; resumed: boolean; said: string; error?: string }
  const record = await forkBroker({
    stateDir, cwd, sessionId, executablePath: claudeBin, env, permissionMode: "bypassPermissions",
    model: process.env.PROBE_MODEL ?? "opus", appendSystemPrompt: systemPromptFor(arm),
  })
  const client = connectClaudeBroker(record.socketPath, {
    onEvent: (event: ClaudeQueryEvent) => {
      if (event.kind === "result") results++
      if (event.kind !== "assistant") return
      toolUses += event.toolUses.length
      const text = event.text.join(" ").replace(/\s+/g, " ").trim()
      if (cutAt !== undefined && text) said.push(text)
      if (event.toolUses.length) log(`tools=${event.toolUses.map((t) => t.name).join(",")}`)
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
    if (!await waitFor(() => toolUses >= 1, 120_000)) throw new Error("the build never started")
    await new Promise((r) => setTimeout(r, 6_000))
    log("remark + interrupt")
    client.sendInput({ id: randomUUID(), text: REMARK })
    client.interrupt()
    cutAt = Date.now()
    // Went back to it = DONE.txt. Stopped = the turn the remark opened ended with no DONE.txt (the
    // interrupted turn's own result is the first of the two).
    const resultsAtCut = results
    await waitFor(() => existsSync(join(cwd, "DONE.txt")) || results >= resultsAtCut + 2, 130_000)
    report.resumed = existsSync(join(cwd, "DONE.txt"))
    report.said = (said[0] ?? "").slice(0, 220)
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err)
  } finally {
    try { client.close() } catch {}
    try { killBroker(stateDir, sessionId) } catch {}
    // The daemon is still writing its last diagnostics as it dies; a busy directory is not a failure.
    await new Promise((r) => setTimeout(r, 500))
    try { rmSync(stateDir, { recursive: true, force: true }) } catch {}
    try { rmSync(cwd, { recursive: true, force: true }) } catch {}
  }
  log(report.error ? `ERROR ${report.error}` : report.resumed ? "went back to the build" : `STOPPED — ${JSON.stringify(report.said)}`)
  return report
}

const specs = process.argv.slice(2).length ? process.argv.slice(2) : ["without:3", "contract:3"]
const jobs: ReturnType<typeof run>[] = []
for (const spec of specs) {
  const [arm, runs] = spec.split(":")
  if (arm !== "bare" && arm !== "without" && arm !== "contract") throw new Error(`unknown arm "${arm}" — bare, without or contract`)
  for (let i = 1; i <= Number(runs ?? 1); i++) jobs.push(run(arm, i))
}
const reports = await Promise.all(jobs)

console.log("\n──────── ANALYSIS ────────")
const tally = new Map<string, { resumed: number; ran: number }>()
for (const r of reports) {
  const arm = r.arm.split("#")[0]!
  const t = tally.get(arm) ?? { resumed: 0, ran: 0 }
  if (!r.error) { t.ran++; if (r.resumed) t.resumed++ }
  tally.set(arm, t)
}
for (const [arm, t] of tally) console.log(`${arm.padEnd(9)}: ${t.resumed} of ${t.ran} went back to the build`)
const errors = reports.filter((r) => r.error)
for (const r of errors) console.log(`ERROR ${r.arm}: ${r.error}`)
// The one claim this probe can fail on: under the contract as built, a worker goes back to the work.
const built = tally.get("contract")
const pass = errors.length === 0 && (!built || built.resumed === built.ran)
console.log(pass ? "\nALL PASS" : "\nFAIL")
process.exit(pass ? 0 : 1)
