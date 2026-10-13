#!/usr/bin/env node
// A SCRIPTED CLAUDE — a stand-in `claude` binary that a real Frizz drives through the real broker
// daemon, and that writes the real transcript JSONL a live Claude Code would. Everything between the
// browser and the model is the product's own code: dispatch, the broker socket, the delivery ledger,
// the runtime-event ingest, the tailer, the board deltas and the transcript pushes. Only the model is
// replaced, by a turn script with fixed timings, so a layout recording can be repeated exactly.
//
// WHY IT EXISTS. Layout work needs a worker whose turns end the way real ones do — a reply, then its
// `end_turn` record, then the `result` a few milliseconds later, in that race — and the only honest way
// to get that was a live model. A live Claude under a sandbox HOME raises a macOS "Keychain Not Found"
// dialog the moment its OAuth token is due (AGENTS.md § Never put a macOS keychain dialog on the
// maintainer's screen; two of them on 2026-10-13, from layout recordings). This binary holds no
// credential, never touches the keychain, and runs on any sandbox stack.
//
// USE — boot a stack with it as the Claude binary, then dispatch with a script token in the prompt:
//
//   nub scripts/adhoc-stack.mjs --port=4980 --claude-bin=/abs/path/to/scripts/scripted-claude.mjs
//   api.mutate("dispatch", { prompt: "[script ending=steps paras=3] anything", backend: "claude" })
//
// The FIRST message's `[script …]` token sets the session's behaviour; every later message (a Done,
// an answer, a steer) is replied to with the `reply…` settings. Keys, all optional:
//
//   ending=done|steps|needs|bare|question   how the first turn ends (default done). `question` runs
//                                           `frizzctl ask` mid-turn, the way a real worker registers one
//   paras=N        paragraphs of prose in the first turn's final message (default 3)
//   tools=N        Bash tool calls before that message, each `toolms` long (default 0, 1500ms)
//   thinking=1     a thinking block before the final message (a "Thought for Ns" row)
//   think=MS       how long the model "thinks" before its first record (default 1500)
//   reply=done|steps|needs|bare   how every later turn ends (default done)
//   replyparas=N   replytools=N   replythink=MS    the same knobs for later turns (defaults 2, 0, 1500)
//   replythinking=1  a thinking block OPENING every later turn, before its tool calls — the shape a real
//                  extended-thinking turn writes (thinking, then tool_use, under one message id) — held
//                  for `thinkms` (default 2000) before the first call
//   gapms=MS       the model's pause between a tool result and its next call (default 0) — the inter-call
//                  gap where the slot reads `Ran N tool calls. Thinking…`
//   reply=question registers a question mid-turn in every later turn too, the way `ending=question` does
//   disklag=MS     event → JSONL write delay for each assistant record (default 15)
//   resultlag=MS   final event → `result` delay (default 30). With the defaults the final record reaches
//                  disk BEFORE the result, the order measured on real broker sessions (94c6b0ee);
//                  `disklag=40 resultlag=10` is the other order, the result first.
//
// A TURN SCRIPT, for a test that has to say exactly what the worker writes and runs — a ```question
// fence, a broken one, a reference, a ```done fence, `frizzctl done`. The knobs above generate a turn;
// this states it:
//
//   file=/abs/turns.json   (an absolute path with no spaces; the knobs above may ride beside it)
//
//   { "think": 300,                          ms before a scripted turn's first record (default: the knobs')
//     "turns": [
//       { "name": "asks",                    a label, for the log below
//         "on": "text the message contains", or "onRe": "a JavaScript regular expression"; neither = any
//         "times": 1,                        how many messages this entry answers (default 1; 0 = every one)
//         "think": 300,                      this turn's own delay
//         "tools": [                         shell commands, run for real before the final message, in order,
//           "frizzctl done --body 'x'",      each a Bash tool call whose result is the command's own output
//           { "command": "…", "description": "…", "ms": 500, "timeout": 30000 } ],
//         "text": "the final message, verbatim" } ],
//     "otherwise": { "tools": [], "text": "…" } }      answers a message no entry takes
//
// Every incoming message that starts a turn (the dispatch prompt first, then each follow-up, wake, answer
// or correction) is answered by the FIRST entry of `turns` that still has a use left and whose `on`/`onRe`
// accepts the message's text; with none, by `otherwise`; with no `otherwise`, by a generated turn from the
// `reply…` knobs, as if there were no file. So a list with no `on` at all is a plain sequence, and an entry
// keyed on a wake's lead (`"on": "⚠️ Your ```question fence "`) answers that wake whenever it arrives.
//
// A tool command runs through `/bin/sh -c` in the worker's own cwd and environment — the broker daemon's,
// with `<--plugin-dir>/bin` first on PATH as Claude Code has it — so `frizzctl` is the one beside the
// stack's own server and reaches that server. Its result is written the way Claude Code
// writes a Bash result: stdout then stderr, and for a non-zero exit `Exit code N` on the first line with
// `is_error: true`. `"ms"` holds the call open that long after the command returns.
//
// Each choice is appended to `<file>.log` as one JSON line ({ at, turn, entry, name, message }), so a
// verifier can say which entry answered which message. A session started again with `--resume` reads its
// own transcript back, re-reads the file and replays those choices, so an entry is not spent twice.
//
// A message that arrives while a turn runs is a STEER, handled the way Claude Code 2.1.296 writes it:
// a `queue-operation enqueue` at once; handed over at the next tool boundary (`queued_command`
// attachment + `remove`) or, when no tool call is left, after the turn ends (`dequeue` + a user record),
// which then starts a reply turn.
//
// `<bin> auth status --json` answers signed in, so the dispatch preflight passes on a sandbox HOME.
// The protocol half (initialize, controls) follows packages/server/src/backend/claude-agent-sdk.fixtures/
// fake-claude-cli.mjs, the stand-in the Agent SDK contract tests drive the same broker with.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { createInterface } from "node:readline"

const args = process.argv.slice(2)
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: "scripted", apiProvider: "firstParty" })}\n`)
  process.exit(0)
}
if (args.includes("--version") || args[0] === "-v") {
  process.stdout.write("2.1.296 (Claude Code)\n")
  process.exit(0)
}

function optionValue(flag) {
  const index = args.indexOf(flag)
  if (index >= 0) return args[index + 1]
  return args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
}
const sessionId = optionValue("--session-id") ?? optionValue("--resume") ?? randomUUID()
const cwd = process.cwd()
const transcript = join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`)
mkdirSync(join(transcript, ".."), { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
let parentUuid = null
function write(record) {
  const full = { parentUuid, isSidechain: false, userType: "external", cwd, sessionId, version: "2.1.296", ...record }
  if (record.uuid) parentUuid = record.uuid
  appendFileSync(transcript, `${JSON.stringify(full)}\n`)
}
const now = () => new Date().toISOString()

// ---- the script ----
const defaults = { ending: "done", paras: 3, tools: 0, toolms: 1500, thinking: 0, think: 1500, thinkms: 2000, replythinking: 0, gapms: 0, reply: "done", replyparas: 2, replytools: 0, replythink: 1500, disklag: 15, resultlag: 30 }
let config = null
function parseScript(text) {
  const token = /\[script([^\]]*)\]/.exec(text)?.[1] ?? ""
  const out = { ...defaults }
  for (const [, key, value] of token.matchAll(/(\w+)=([\w.-]+)/g)) {
    out[key] = /^\d+$/.test(value) ? Number(value) : value
  }
  // A path is not a knob value (`[\w.-]+` stops at the first slash), so it is read on its own.
  const file = /(?:^|\s)file=(\/[^\s\]]+)/.exec(token)?.[1]
  if (file) out.file = file
  else delete out.file
  return out
}

// ---- the turn script (`file=`) ----
// What the file said, with a use count per entry. Null when the session has no file, or it could not be
// read — in which case every turn is a generated one and the failure is on stderr and in the first reply.
let script = null
let scriptFault = ""
function loadScript(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    const entry = (raw) => ({
      name: typeof raw.name === "string" ? raw.name : undefined,
      on: typeof raw.on === "string" ? raw.on : undefined,
      onRe: typeof raw.onRe === "string" ? new RegExp(raw.onRe) : undefined,
      times: Number.isInteger(raw.times) && raw.times >= 0 ? raw.times : 1,
      think: Number.isFinite(raw.think) ? raw.think : undefined,
      tools: (Array.isArray(raw.tools) ? raw.tools : []).map((t) => (typeof t === "string" ? { command: t } : t)).filter((t) => typeof t?.command === "string"),
      text: typeof raw.text === "string" && raw.text.trim() ? raw.text : "(a scripted turn with no text)",
      used: 0,
    })
    script = {
      file,
      think: Number.isFinite(parsed.think) ? parsed.think : undefined,
      turns: (Array.isArray(parsed.turns) ? parsed.turns : []).map(entry),
      otherwise: parsed.otherwise && typeof parsed.otherwise === "object" ? entry(parsed.otherwise) : undefined,
    }
  } catch (error) {
    scriptFault = `scripted-claude: could not read the turn script ${file}: ${error instanceof Error ? error.message : String(error)}`
    process.stderr.write(`${scriptFault}\n`)
  }
}
/** The entry that answers `text`, counted as used — or undefined for a generated turn. */
function takeEntry(text, { log = true } = {}) {
  if (!script) return undefined
  const index = script.turns.findIndex((e) => (e.times === 0 || e.used < e.times) && (e.on === undefined || text.includes(e.on)) && (e.onRe === undefined || e.onRe.test(text)))
  const entry = index >= 0 ? script.turns[index] : script.otherwise
  if (entry) entry.used += 1
  if (log) {
    try {
      appendFileSync(`${script.file}.log`, `${JSON.stringify({ at: now(), sessionId, turn: turnNumber + 1, entry: index >= 0 ? index : entry ? "otherwise" : "generated", name: entry?.name, message: text.slice(0, 160) })}\n`)
    } catch {}
  }
  return entry
}
// Claude Code puts an enabled plugin's `bin/` first on its Bash PATH, which is how a worker's `frizzctl`
// is the one beside the server that dispatched it (`--plugin-dir=<repo>/cc-worker`) and not whatever a
// `frizzctl` further down the inherited PATH happens to be: a stack booted from inside a Frizz worker
// inherits the machine's installed one.
const pluginDir = optionValue("--plugin-dir")
const toolEnv = pluginDir && process.env.PATH ? { ...process.env, PATH: `${join(pluginDir, "bin")}:${process.env.PATH}` } : process.env
function runShell(tool) {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", tool.command], { cwd, env: toolEnv, timeout: Number.isFinite(tool.timeout) ? tool.timeout : 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: error && typeof error.code !== "number" ? `${stderr}${error.message}` : String(stderr) })
    })
  })
}

const PARAGRAPH = "Release engineering is the discipline of shipping exactly what you tested: a pipeline checks out one commit, builds it hermetically, records where every artifact came from, and publishes only after every gate it depends on has passed on that same revision."
const prose = (n, lead) => [lead, ...Array.from({ length: n }, (_, i) => `${i + 1}. ${PARAGRAPH}`)].filter(Boolean).join("\n\n")
const FENCES = {
  done: "```done\n- **Explained the release pipeline** in the prose above.\n```",
  steps: "```awaiting\ntitle: Approve the npm sign-in so the release can publish\nsteps:\n  - Open [the npm sign-in page](https://www.npmjs.com/login) and sign in with the maintainer account.\n  - Approve the request with that account's security key or one-time code.\n---\n`npm login --auth-type=web` is waiting on that approval.\n```",
  needs: "```awaiting\nstatus: needs_input\ntitle: Two of three audits ready\nfor: 1h\n---\nTwo audits are written and can be read now; the third is still running.\n```",
  bare: "",
  question: "",
}

// ---- turns ----
let turnNumber = 0
let running = false
const queued = [] // steers waiting for the next handover point: { text, uuid }

async function assistantRecord(messageId, block, stopReason, s) {
  const uuid = randomUUID()
  send({ type: "assistant", message: { id: messageId, type: "message", role: "assistant", model: "claude-haiku-5-5", content: [block], stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null, uuid, session_id: sessionId })
  await sleep(s.disklag)
  write({ type: "assistant", message: { model: "claude-haiku-5-5", id: messageId, type: "message", role: "assistant", content: [block], stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, uuid, timestamp: now() })
}

function deliverAtToolBoundary() {
  // Claude Code hands a queued message over WITH the tool result: the attachment, then the removal.
  while (queued.length) {
    const { text, uuid } = queued.shift()
    write({ type: "attachment", attachment: { type: "queued_command", prompt: text, source_uuid: uuid, commandMode: "prompt", timestamp: now() }, uuid: randomUUID(), timestamp: now() })
    appendFileSync(transcript, `${JSON.stringify({ type: "queue-operation", operation: "remove", timestamp: now(), sessionId, content: text })}\n`)
    send({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid, session_id: sessionId })
  }
}

async function runTurn(kind) {
  running = true
  turnNumber += 1
  const s = config
  const first = kind === "first"
  const ending = first ? s.ending : s.reply
  const tools = first ? s.tools : s.replytools
  const paras = first ? s.paras : s.replyparas
  await sleep(first ? s.think : s.replythink)
  if (!first && s.replythinking) {
    await assistantRecord(tools ? `msg_scripted_${turnNumber}_t0` : `msg_scripted_${turnNumber}`, { type: "thinking", thinking: "", signature: "scripted" }, null, s)
    await sleep(s.thinkms)
  }
  for (let i = 0; i < tools; i++) {
    if (i > 0 && s.gapms) await sleep(s.gapms)
    const id = `toolu_scripted_${turnNumber}_${i}`
    await assistantRecord(`msg_scripted_${turnNumber}_t${i}`, { type: "tool_use", id, name: "Bash", input: { command: `sleep ${Math.round(s.toolms / 1000)}`, description: `Running step ${i + 1} of ${tools}` } }, "tool_use", s)
    await sleep(s.toolms)
    const resultUuid = randomUUID()
    write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "", is_error: false }] }, uuid: resultUuid, timestamp: now(), toolUseResult: { stdout: "", stderr: "", interrupted: false } })
    send({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "" }] }, parent_tool_use_id: null, uuid: resultUuid, session_id: sessionId, isSynthetic: true })
    deliverAtToolBoundary()
  }
  if (ending === "question") await registerQuestion()
  const messageId = `msg_scripted_${turnNumber}`
  if (first && s.thinking) await assistantRecord(messageId, { type: "thinking", thinking: "", signature: "scripted" }, null, s)
  const fence = FENCES[ending] ?? ""
  const lead = ending === "question" ? "One decision is needed before this can go further; it is registered as a question." : undefined
  await finishTurn(messageId, [prose(paras, lead), fence].filter(Boolean).join("\n\n"), s)
}

/** The turn's final message, its `result`, and whatever waited the turn out. */
async function finishTurn(messageId, text, s) {
  // The final record and the `result` each trail the final event by their OWN lag, so either can win:
  // `resultlag < disklag` is the result reaching Frizz before the record reaches the disk.
  const landed = assistantRecord(messageId, { type: "text", text }, "end_turn", s)
  await sleep(s.resultlag)
  send({ type: "result", subtype: "success", duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: "", stop_reason: "end_turn", total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], uuid: randomUUID(), session_id: sessionId })
  await landed
  running = false
  // A message that waited out the turn is handed over now and starts the next one.
  if (queued.length) {
    const { text, uuid } = queued.shift()
    appendFileSync(transcript, `${JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: now(), sessionId })}\n`)
    acceptInput(text, uuid)
  }
}

/** One entry of the turn script: its commands as real Bash tool calls, then its text. */
async function runScriptedTurn(entry, kind) {
  running = true
  turnNumber += 1
  const s = config
  await sleep(entry.think ?? script?.think ?? (kind === "first" ? s.think : s.replythink))
  for (let i = 0; i < entry.tools.length; i++) {
    const tool = entry.tools[i]
    const id = `toolu_scripted_${turnNumber}_${i}`
    await assistantRecord(`msg_scripted_${turnNumber}_t${i}`, { type: "tool_use", id, name: "Bash", input: { command: tool.command, description: tool.description ?? `Running step ${i + 1} of ${entry.tools.length}` } }, "tool_use", s)
    const ran = await runShell(tool)
    if (tool.ms) await sleep(tool.ms)
    const output = [ran.stdout, ran.stderr].filter(Boolean).join(ran.stdout.endsWith("\n") || !ran.stdout ? "" : "\n").trimEnd()
    const failed = ran.code !== 0
    const content = failed ? `Exit code ${ran.code}${output ? `\n${output}` : ""}` : output
    const resultUuid = randomUUID()
    write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: failed }] }, uuid: resultUuid, timestamp: now(), toolUseResult: failed ? `Error: ${content}` : { stdout: ran.stdout, stderr: ran.stderr, interrupted: false } })
    send({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(failed ? { is_error: true } : {}) }] }, parent_tool_use_id: null, uuid: resultUuid, session_id: sessionId, isSynthetic: true })
    deliverAtToolBoundary()
  }
  await finishTurn(`msg_scripted_${turnNumber}`, turnNumber === 1 && scriptFault ? `${scriptFault}\n\n${entry.text}` : entry.text, s)
}

/** Start the turn that answers `text`: the script's entry for it, or a generated one. */
function startTurn(kind, text) {
  const entry = takeEntry(text)
  void (entry ? runScriptedTurn(entry, kind) : runTurn(kind))
}

function registerQuestion() {
  const spec = { questions: [{ question: "Publish the release now, or hold it for the changelog?", kind: "question", options: [{ label: "Publish now", description: "every gate passed on this commit", recommended: true }, { label: "Hold it", description: "the changelog entry is still a draft" }] }] }
  return new Promise((resolve) => {
    const child = execFile("frizzctl", ["ask", "--input", "-"], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) process.stderr.write(`scripted-claude: frizzctl ask failed: ${String(stderr || error.message).slice(0, 300)}\n`)
      resolve(stdout)
    })
    child.stdin?.end(JSON.stringify(spec))
  })
}

function acceptInput(text, uuid) {
  write({ type: "user", message: { role: "user", content: text }, uuid: randomUUID(), timestamp: now(), promptSource: "sdk" })
  send({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid, session_id: sessionId })
  startTurn("reply", text)
}

function handleUserMessage(message) {
  const content = message.message?.content
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : ""
  const uuid = message.uuid ?? randomUUID()
  if (config === null) {
    config = parseScript(text)
    if (config.file) loadScript(config.file)
    write({ type: "user", message: { role: "user", content: text }, uuid: randomUUID(), timestamp: now(), promptSource: "sdk" })
    send({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid, session_id: sessionId })
    startTurn("first", text)
    return
  }
  if (running) {
    appendFileSync(transcript, `${JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: now(), sessionId, content: text })}\n`)
    queued.push({ text, uuid })
    return
  }
  acceptInput(text, uuid)
}

// ---- the protocol half (see fake-claude-cli.mjs) ----
function respond(requestId, response, extra = {}) {
  send({ type: "control_response", response: { subtype: "success", request_id: requestId, response, ...extra } })
}
let systemInitSent = false
function handleHostControl(message) {
  const request = message.request ?? {}
  switch (request.subtype) {
    case "initialize":
      respond(message.request_id, {
        commands: [], agents: [], output_style: "default", available_output_styles: ["default"], account: {},
        models: [{ value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku (scripted)", description: "Scripted stand-in", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"], supportsAdaptiveThinking: true, supportsFastMode: false }],
      })
      if (!systemInitSent) {
        systemInitSent = true
        send({ type: "system", subtype: "init", apiKeySource: "none", claude_code_version: "2.1.296", cwd, tools: ["Bash"], mcp_servers: [], model: "claude-haiku-5-5", permissionMode: optionValue("--permission-mode") ?? "default", slash_commands: [], output_style: "default", skills: [], plugins: [], capabilities: ["interrupt_receipt_v1"], uuid: randomUUID(), session_id: sessionId })
      }
      return
    case "interrupt":
      return respond(message.request_id, { still_queued: [] })
    case "cancel_async_message": {
      const i = queued.findIndex((q) => q.uuid === request.message_uuid)
      if (i >= 0) queued.splice(i, 1)
      return respond(message.request_id, { cancelled: i >= 0 })
    }
    case "get_context_usage":
      return respond(message.request_id, { skills: { totalSkills: 0, includedSkills: 0, tokens: 0, skillFrontmatter: [] }, isAutoCompactEnabled: false })
    case "generate_session_title":
      return respond(message.request_id, { title: String(request.description ?? "Scripted session").replace(/\[script[^\]]*\]\s*/, "").slice(0, 48) || "Scripted session" })
    case "reload_plugins":
      return respond(message.request_id, { commands: [], agents: [], plugins: [], mcpServers: [], error_count: 0 })
    default:
      return respond(message.request_id, {})
  }
}

// A RESUMED SESSION PICKS ITS SCRIPT UP WHERE IT LEFT IT. `--resume` starts a new process on an old
// transcript; without this the next message would be read as the first, find no `[script …]` token and
// be answered by a default turn. Every user record with a string body started a turn, so replaying them
// against the file spends the same entries the first process spent. Only a session scripted from a file
// is recovered: one driven by knobs alone behaves on resume as it always has.
if (optionValue("--resume") && existsSync(transcript)) {
  const started = []
  let last = null
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record.uuid) last = record.uuid
    if (record.type === "user" && typeof record.message?.content === "string") started.push(record.message.content)
  }
  const recovered = started.length ? parseScript(started[0]) : undefined
  if (recovered?.file) {
    config = recovered
    loadScript(recovered.file)
    parentUuid = last
    for (const text of started) {
      takeEntry(text, { log: false })
      turnNumber += 1
    }
  }
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.type === "control_request") handleHostControl(message)
  else if (message.type === "user") handleUserMessage(message)
}).on("close", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))
