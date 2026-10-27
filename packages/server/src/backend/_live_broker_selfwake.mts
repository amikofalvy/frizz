// LIVE probe: when a FINISHED background sub-agent restarts with no resume ack in its parent's
// transcript, does the provider announce the new run on the stream — and does the board follow?
//   nub packages/server/src/backend/_live_broker_selfwake.mts [selfwake|latemsg]
//
// tailer.ts reviveRestarted rests on one claim: such a restart emits a fresh `task_started` under the
// child's SAME task id, which the ingest stamps as `restartedAt` because it follows an end it folded.
// Two restarts leave no `resumedAgentId` ack for trackResumes to fold:
//
//   · selfwake — the child ends its turn with its own background shell still running; the shell
//     finishing re-invokes it ("It may resume on its own when that work completes").
//   · latemsg  — the parent's `SendMessage` arrives while the child is writing its final reply, is
//     "queued for delivery … at its next tool round", and the child, having no next tool round,
//     is resumed with it once it ends.
//
// Two tailers fold the SAME session off the SAME ingest. `tailer` is the code under test. `control`
// is handed the ingest's tasks with `restartedAt` stripped, which is exactly what the fold did before
// reviveRestarted existed — the in-run negative control, so a pass cannot come from a workload that
// never retired the row in the first place.
//
// MEASURED 2026-10-27 on Claude Code 2.1.296 (sonnet), one run each, ALL CHECKS PASSED both times:
//   · selfwake — the child ended at t+12.8s with its shell running; the shell finished at t+54.3s and
//     the stream carried `task_started` for the child's task id with its ORIGINAL dispatch tool_use id.
//     The fold under test showed the child again at t+54.5s and retired it at t+58.0s when the second
//     run ended; the control showed nothing the whole time it worked.
//   · latemsg — the SendMessage came back "Message queued for delivery … at its next tool round" while
//     the child was writing its essay. The child's terminal and a fresh `task_started` (same task id,
//     same dispatch id) arrived together at t+54.6s; the child then replied GOT-IT. The fold under test
//     held the row through it, the control dropped it.
// In both, the restarted run's own `<task-notification>` carried a `<task-id>` and no `<tool-use-id>`.
// The latemsg timing is the fragile part: a send that lands before the child's last tool result is
// delivered within the run, which restarts nothing (the first attempt did exactly that).
//
// It prints the raw evidence first. Read the dump; the PASS/FAIL lines below it are only a summary.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { createClaudeRuntimeIngest } from "./claude-runtime-ingest.ts"
import { createTailer, defaultLogDir, type Tailer } from "../tailer.ts"
import { createStorage, type Storage } from "../storage.ts"
import { createClaudeBackend } from "./claude.ts"
import { Bus } from "../bus.ts"
import { cwdSlug, type Project } from "../project.ts"
import type { AgentBackend } from "./types.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const scenario = process.argv[2] === "latemsg" ? "latemsg" : "selfwake"
const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "bselfwake-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bselfwake-repo-"))); execFileSync("git", ["init", "-q", cwd])
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const project: Project = { dir: cwd, id: "live", name: "live", label: "o/live", stateDir, cwdSlug: cwdSlug(cwd) }
const logDir = defaultLogDir(project)
const claudeBackend = createClaudeBackend({ claudeBin, logDir })
const backendFor = (_kind?: string): AgentBackend => claudeBackend

let tailer!: Tailer
let control!: Tailer
const ingest = createClaudeRuntimeIngest({ nudge: () => { try { tailer.nudge?.(); control.nudge?.() } catch { /* ignore */ } } })

const t0 = Date.now()
const rel = (at: number) => `t+${((at - t0) / 1000).toFixed(1)}s`
type TaskEvent = Extract<ClaudeQueryEvent, { kind: "task" }>
const taskEvents: Array<{ at: number; event: TaskEvent }> = []
// The CHILD's dispatch, read off the main thread's own Agent tool_use.
let childToolUseId: string | undefined

const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
  onEvent: (slug, sessionId, event) => {
    if (event.kind === "task") taskEvents.push({ at: Date.now(), event })
    if (event.kind === "assistant" && !event.parentToolUseId) {
      for (const use of event.toolUses) if ((use.name === "Agent" || use.name === "Task") && !childToolUseId) childToolUseId = use.id
    }
    ingest.onEvent(slug, sessionId, event)
  },
})

function makeTailer(storage: Storage, stripRestart: boolean): Tailer {
  return createTailer({
    project, storage, bus: new Bus(), backendFor,
    onChange: () => {}, paneDead: () => false,
    runtimeLiveness: (sessionId) => ingest.liveness(sessionId),
    runtimeTasks: (sessionId) => stripRestart ? ingest.tasks(sessionId).map((task) => ({ ...task, restartedAt: undefined })) : ingest.tasks(sessionId),
  })
}
const storage = createStorage(join(stateDir, "ui.db"), "p")
const controlStorage = createStorage(join(stateDir, "control.db"), "p")
tailer = makeTailer(storage, false)
control = makeTailer(controlStorage, true)

const slug = `selfwake-${scenario}`
const sessionId = randomUUID()

// Every instruction about the notification is there to keep the PARENT out of it: a parent that
// re-steers the child with SendMessage would hand trackResumes an ack, and the probe would measure
// the restart path that already works.
const PROMPT = scenario === "selfwake"
  ? [
    "Dispatch ONE background sub-agent using the Agent tool with run_in_background set to true and description exactly `SELFWAKE-CHILD`.",
    "Its task, verbatim, must be: \"Use the Bash tool with run_in_background set to true to run exactly: sleep 45; echo SHELL-DONE . Do not wait for it, do not poll it and do not read its output now. End your turn immediately by replying exactly CHILD-PAUSED. Later, when you are notified that the shell has finished, run `date` with the Bash tool in the foreground and then reply exactly CHILD-RESUMED.\"",
    "After dispatching it, end your turn immediately by replying exactly PARENT-RESTING.",
    "Whenever you are later notified about that sub-agent, reply exactly NOTED and do nothing else: no tool calls, and never use SendMessage.",
  ].join("\n")
  : [
    "Dispatch ONE background sub-agent using the Agent tool with run_in_background set to true and description exactly `LATEMSG-CHILD`.",
    "Its task, verbatim, must be: \"Run exactly `sleep 20` with the Bash tool in the foreground. Then, with NO further tool calls of any kind, write a 1500-word essay on the history of lighthouses as your final reply.\"",
    // Not a bare `sleep`: Claude Code 2.1.296 refuses a standalone `sleep 32` on the main thread
    // ("Blocked: standalone sleep 32"), and the message then lands at the child's next tool round
    // instead of during its final reply — delivered within the run, with no restart to observe.
    "After dispatching it, run exactly `python3 -c 'import time; time.sleep(33)'` with the Bash tool in the foreground.",
    "Then use the SendMessage tool to send that sub-agent (address it by the agentId the Agent tool returned) exactly this message: Reply exactly GOT-IT and nothing else.",
    "Then end your turn by replying exactly PARENT-SENT.",
    "Whenever you are later notified about that sub-agent, reply exactly NOTED and do nothing else: no tool calls, and never use SendMessage again.",
  ].join("\n")

function readRecords(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  const out: Array<Record<string, unknown>> = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* partial line */ }
  }
  return out
}
function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "")).join("\n")
}

try {
  await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd, prompt: PROMPT, permissionMode: "bypassPermissions", model: "sonnet" })
  for (const s of [storage, controlStorage]) {
    s.upsertSession({
      slug, session_id: sessionId, thread_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
      last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
      title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
    })
    s.setBackend(slug, "claude")
    s.setClaudeRuntime(slug, "broker")
  }
  tailer.tick(); control.tick()

  const deadline = Date.now() + 480_000
  const timeline: string[] = []
  let settled = 0
  while (Date.now() < deadline) {
    tailer.tick(); control.tick()
    const view = (t: Tailer) => {
      const tele = t.get(slug)
      return { turn: tele?.turn, live: (tele?.subAgents ?? []).map((v) => `${v.label}|${v.id}|${v.state}`) }
    }
    const a = view(tailer)
    const b = view(control)
    const childTask = ingest.tasks(sessionId).find((task) => childToolUseId && (task.toolUseId === childToolUseId || task.description?.includes("CHILD")))
    const line = `turn=${a.turn} pr-live=[${a.live.join(", ")}] control-live=[${b.live.join(", ")}] task=${childTask ? `${childTask.taskId}:${childTask.terminal ? "terminal" : "running"}${childTask.restartedAt ? `:restartedAt=${rel(childTask.restartedAt)}` : ""}` : "-"}`
    if (!timeline.at(-1)?.endsWith(line)) timeline.push(`${rel(Date.now())} ${line}`)
    const childNotifications = childTask ? taskEvents.filter((e) => e.event.taskId === childTask.taskId && e.event.phase === "notification").length : 0
    if (childNotifications >= 2 && a.turn === "idle" && a.live.length === 0) { if (++settled >= 6) break } else settled = 0
    await sleep(500)
  }

  console.log("\n      --- board timeline (deduped; pr = the fold under test, control = the same fold without restartedAt) ---")
  for (const line of timeline) console.log("      " + line)

  console.log("\n      --- RAW task events ---")
  for (const { at, event } of taskEvents) {
    const level = event.phase === "level" ? ` tasks=[${(event.tasks ?? []).map((t) => t.taskId).join(",")}]` : ""
    console.log(`      ${rel(at).padEnd(9)} ${event.phase.padEnd(12)} task=${event.taskId ?? "-"} toolUse=${event.toolUseId ?? "-"} type=${event.taskType ?? "-"} status=${event.status ?? "-"} desc=${JSON.stringify(event.description ?? "").slice(0, 60)}${level}`)
  }

  const parentPath = join(logDir, `${sessionId}.jsonl`)
  const parent = readRecords(parentPath)
  console.log("\n      --- parent transcript: SendMessage results and task notifications ---")
  const sendResults: string[] = []
  const notifications: Array<{ at: string; block: string }> = []
  for (const rec of parent) {
    const content = (rec.message as { content?: unknown } | undefined)?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: string; content?: unknown }
        if (b?.type === "tool_result" && textOf(b.content).includes("success") && /Message queued|resumed|Resuming/.test(textOf(b.content))) sendResults.push(textOf(b.content))
      }
    }
    const raw = typeof rec.content === "string" ? rec.content : typeof (rec.attachment as { prompt?: unknown } | undefined)?.prompt === "string" ? (rec.attachment as { prompt: string }).prompt : textOf(content)
    for (const block of raw.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) notifications.push({ at: String(rec.timestamp ?? "?"), block })
  }
  for (const s of sendResults) console.log(`      SendMessage → ${s.slice(0, 300)}`)
  const seenBlocks = new Set<string>()
  for (const n of notifications) {
    if (seenBlocks.has(n.block)) continue
    seenBlocks.add(n.block)
    console.log(`      ${n.at} ${n.block.replace(/\s+/g, " ").slice(0, 420)}`)
  }

  const subDir = join(logDir, sessionId, "subagents")
  const childFiles = existsSync(subDir) ? readdirSync(subDir).filter((name) => name.endsWith(".jsonl")) : []
  console.log("\n      --- child transcripts ---")
  const childStamps: number[] = []
  for (const name of childFiles) {
    const recs = readRecords(join(subDir, name))
    const stamps = recs.map((r) => Date.parse(String(r.timestamp ?? ""))).filter(Number.isFinite)
    childStamps.push(...stamps)
    const texts = recs.filter((r) => r.type === "assistant").map((r) => textOf((r.message as { content?: unknown } | undefined)?.content).trim()).filter(Boolean)
    console.log(`      ${name} records=${recs.length} first=${stamps.length ? rel(Math.min(...stamps)) : "-"} last=${stamps.length ? rel(Math.max(...stamps)) : "-"} replies=${JSON.stringify(texts.map((t) => t.slice(0, 40)))}`)
  }

  // ---- the questions ----
  const childTask = ingest.tasks(sessionId).find((task) => task.toolUseId === childToolUseId || task.description?.includes("CHILD"))
  const childEvents = childTask ? taskEvents.filter((e) => e.event.taskId === childTask.taskId) : []
  const firstEnd = childEvents.find((e) => e.event.phase === "notification")
  const restartStarts = firstEnd ? childEvents.filter((e) => e.event.phase === "started" && e.at > firstEnd.at) : []
  const childWroteAfterEnd = firstEnd ? childStamps.some((at) => at > firstEnd.at + 1000) : false
  console.log(`\n      child dispatch tool_use=${childToolUseId ?? "-"} task=${childTask?.taskId ?? "-"} first end=${firstEnd ? rel(firstEnd.at) : "-"}`)
  if (scenario === "latemsg") {
    ok("the SendMessage was QUEUED (no resumedAgentId), so no ack can revive the row",
      sendResults.some((s) => s.includes("Message queued") && !s.includes("resumedAgentId")), sendResults.map((s) => s.slice(0, 80)).join(" | ") || "no SendMessage result")
  }
  ok("the child's first run ENDED on the stream", Boolean(firstEnd))
  ok("the child really ran again after that end (its transcript grew)", childWroteAfterEnd)
  ok("a task_started under the SAME task id followed the end (the claim)", restartStarts.length > 0,
    restartStarts.map((e) => `${rel(e.at)} toolUse=${e.event.toolUseId ?? "-"}`).join(", "))
  ok("the ingest stamped restartedAt", childTask?.restartedAt !== undefined)
  const prRevived = timeline.some((line) => firstEnd && line.includes(`pr-live=[`) && childToolUseId && line.split("control-live")[0].includes(childToolUseId) && Number.parseFloat(line.slice(2)) * 1000 + t0 > firstEnd.at + 500)
  ok("the fold under test brought the child back as its ORIGINAL row", prRevived)
  const controlRevived = timeline.some((line) => firstEnd && childToolUseId && line.split("control-live")[1]?.includes(childToolUseId) && Number.parseFloat(line.slice(2)) * 1000 + t0 > firstEnd.at + 500)
  ok("the control fold (no restartedAt) did NOT — the bug reproduces without the fix", !controlRevived)
  ok("and the fold under test retired it again when the restarted run ended", timeline.at(-1)?.includes("pr-live=[]") ?? false)
} catch (error) {
  failures++
  console.log("FAIL  harness threw —", error)
} finally {
  try { bridge.releaseSession(slug, sessionId, "session-deleted") } catch { /* ignore */ }
  try { bridge.close() } catch { /* ignore */ }
  try { ingest.close() } catch { /* ignore */ }
  try { tailer.stop(); control.stop() } catch { /* ignore */ }
  try { storage.close(); controlStorage.close() } catch { /* ignore */ }
  console.log(`\n      (log dir left in place for inspection: ${logDir}${existsSync(logDir) ? "" : " — MISSING"})`)
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
