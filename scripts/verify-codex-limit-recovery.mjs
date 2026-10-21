// Real Codex process → Frizz bridge/tailer → scheduler/outbox → real resumed Codex turn.
// Only the external HTTP service is a fixture; no real credential, account, or credit is used.
// Usage: nub scripts/verify-codex-limit-recovery.mjs /absolute/path/to/codex
import assert from "node:assert/strict"
import { createServer } from "node:https"
import { spawn, execFileSync } from "node:child_process"
import { EventEmitter, once } from "node:events"
import { randomUUID } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { WebSocketServer } from "ws"
import { createStorage } from "../packages/server/src/storage.ts"
import { createTailer } from "../packages/server/src/tailer.ts"
import { createScheduler } from "../packages/server/src/scheduler.ts"
import { createCodexBackend } from "../packages/server/src/backend/codex.ts"
import { createCodexAppServerBridge } from "../packages/server/src/backend/codex-app-server.ts"
import { queryCodexRateLimits } from "../packages/server/src/backend/codex-quota.ts"
import { cwdSlug } from "../packages/server/src/project.ts"
import { Bus } from "../packages/server/src/bus.ts"

assert.ok(process.argv[2], "Pass an installed Codex binary")
const bin = resolve(process.argv[2])
const root = mkdtempSync(join(tmpdir(), "frizz-codex-limit-"))
const home = join(root, "home")
const codexHome = join(home, ".codex")
mkdirSync(codexHome, { recursive: true })
const cert = join(root, "cert.pem"), key = join(root, "key.pem")
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
  "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  "-addext", "basicConstraints=critical,CA:FALSE"], { stdio: "ignore" })
const savedCert = process.env.SSL_CERT_FILE
process.env.SSL_CERT_FILE = cert
const project = { id: "probe", dir: root, stateDir: root, name: "probe", label: "probe", cwdSlug: cwdSlug(root) }
const storage = createStorage(join(root, "ui.db"), project.id)
const slug = "capacity-probe", sessionId = randomUUID()
let blocked = true, modelRequests = 0, resumes = 0, lastQuota
let bridge, tailer, scheduler, child
let stderr = ""
const changes = new EventEmitter()
const response = (send) => {
  modelRequests++
  if (blocked) return send({ type: "error", status: 429, error: {
    type: "usage_limit_reached", message: "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
    plan_type: "business", rate_limit_reached_type: { type: "workspace_owner_credits_depleted" },
  } })
  const item = { id: "msg_probe", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "RECOVERED\n\n```done\nVerified recovery.\n```", annotations: [] }] }
  send({ type: "response.created", response: { id: "resp_probe", status: "in_progress", output: [] } })
  send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } })
  send({ type: "response.output_item.done", output_index: 0, item })
  send({ type: "response.completed", response: { id: "resp_probe", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
}
const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, async (req, res) => {
  if (req.url?.includes("/accounts/check")) {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ accounts: [{ id: "probe-account", plan_type: "business",
      workspace_backend_origin: "NO_CONSTRAINT", account_routing_override: "NO_CONSTRAINT" }] }))
  } else if (req.url?.endsWith("/usage")) {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ plan_type: "business", rate_limit: {
      allowed: !blocked, limit_reached: blocked,
      primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: Math.floor(Date.now() / 1000) + 3600 },
    }, credits: { has_credits: !blocked, unlimited: false, balance: blocked ? "0" : "10" },
    rate_limit_reached_type: blocked ? { type: "workspace_owner_credits_depleted" } : null }))
  } else if (req.url?.includes("/responses")) {
    for await (const _ of req) {} // drain request before returning a streaming response
    res.setHeader("content-type", blocked ? "application/json" : "text/event-stream")
    if (blocked) res.statusCode = 429
    response((event) => res.write(blocked ? JSON.stringify({ error: event.error }) : `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
    res.end()
  } else {
    res.setHeader("content-type", "application/json")
    res.end("{}")
  }
})
const sockets = new WebSocketServer({ noServer: true })
server.on("upgrade", (req, socket, head) => sockets.handleUpgrade(req, socket, head, (ws) => {
  ws.on("message", () => response((event) => ws.send(JSON.stringify(event))))
}))
const live = () => bridge?.turnLiveness(slug, sessionId)
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 30_000
  while (!predicate()) {
    assert.ok(!child || child.exitCode === null, `Codex exited while ${label}: ${stderr}`)
    const left = deadline - Date.now()
    assert.ok(left > 0, `Timed out ${label}: ${stderr}`)
    await new Promise((done) => {
      const finish = () => { clearTimeout(timer); changes.off("status", finish); done() }
      const timer = setTimeout(finish, Math.min(left, 1000))
      changes.once("status", finish)
    })
  }
}
try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const origin = `https://127.0.0.1:${server.address().port}`
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const token = `${enc({ alg: "none" })}.${enc({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "probe-account", chatgpt_plan_type: "business" } })}.fixture`
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", last_refresh: new Date().toISOString(), tokens: {
    id_token: token, access_token: token, refresh_token: "fixture", account_id: "probe-account",
  } }))
  writeFileSync(join(codexHome, "config.toml"), `chatgpt_base_url = "${origin}"\nmodel = "gpt-6.1-sol"\n`)
  storage.upsertSession({ slug, session_id: sessionId, thread_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: slug,
    state: "open", meta: null, seen_at: null, transcript_id: null })
  storage.setBackend(slug, "codex")
  storage.setCodexRuntime(slug, "app-server")
  bridge = createCodexAppServerBridge({
    projectId: project.id, projectDir: root, stateDir: root, db: storage.db, interactions: storage.interactions,
    codexBin: bin, codexAuthAccountId: () => "probe-account",
    spawn: (command, args, options) => {
      child = spawn(command, args, { ...options, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, SSL_CERT_FILE: cert, TMPDIR: process.env.TMPDIR } })
      child.stderr.on("data", (chunk) => { stderr += chunk })
      return child
    },
    onStatusChange: () => changes.emit("status"),
  })
  const binding = await bridge.startDisposableSession({ threadSlug: slug, sessionId, cwd: root, ephemeral: false })
  storage.setTranscriptId(slug, binding.codexThreadId)
  storage.setAgentSession(slug, binding.codexThreadId)
  const backend = createCodexBackend({ codexHome })
  tailer = createTailer({ project, storage, bus: new Bus(), backendFor: () => backend, paneDead: () => false, onChange: () => {} })
  scheduler = createScheduler({
    storage, tailer, wakeQuietWindowMs: 0, codexTurnLiveness: () => live(),
    readQuota: async () => {
      lastQuota = await queryCodexRateLimits(codexHome, bin) ?? { status: "unavailable", windows: [] }
      return { claude: { status: "unavailable", windows: [] }, codex: lastQuota }
    },
    resume: async (_slug, text, deliveryId) => {
      resumes++
      await bridge.followUp({ threadSlug: slug, sessionId, text, deliveryId })
    },
    log: console.log,
  })
  await bridge.startTurn({ threadSlug: slug, sessionId, text: "Reply with RECOVERED." })
  await waitFor(() => live()?.providerError && !live().bridgeTurn, "waiting for the real usage failure")
  console.log("Codex terminal error:", live().providerError)
  assert.equal(live().providerError.code, "usage_limit_exceeded")
  console.log("PASS real Codex produced the typed usage failure")
  await waitFor(() => { tailer.tick(); return !!tailer.get(slug)?.limitFault }, "reading the durable failure rollout")
  assert.ok(tailer.get(slug)?.limitFault?.codex, "the durable rollout also enters recovery")
  await scheduler.tick()
  assert.equal(resumes, 0, "negative control: no immediate blind retry")
  console.log("Waiting for the production minimum-fault-age guard")
  await delay(121_000)
  await scheduler.tick()
  assert.equal(resumes, 0, "negative control: empty workspace credits block despite 0% window usage")
  const before = modelRequests
  blocked = false
  await scheduler.tick()
  assert.equal(resumes, 1, `Expected a recovery from ${JSON.stringify(lastQuota)}`)
  await waitFor(() => !live()?.bridgeTurn, "waiting for the resumed real turn")
  assert.equal(live()?.providerError, undefined)
  assert.equal(resumes, 1)
  assert.ok(modelRequests > before, "recovery reached the actual model transport")
  tailer.tick()
  assert.equal(tailer.get(slug)?.limitFault, undefined)
  assert.match(tailer.get(slug)?.lastAssistant ?? "", /RECOVERED/)
  await scheduler.tick()
  assert.equal(resumes, 1, "the same interruption is not delivered twice")
  console.log("PASS real quota read → scheduler/outbox → bridge → real Codex response; one recovery only")
} catch (error) {
  console.error(stderr)
  throw error
} finally {
  await scheduler?.stop()
  tailer?.stop()
  const exited = child && child.exitCode === null && child.signalCode === null ? once(child, "exit") : Promise.resolve()
  const kill = setTimeout(() => child?.kill("SIGKILL"), 5_000)
  try { await bridge?.shutdown(); await exited } finally { clearTimeout(kill) }
  for (const ws of sockets.clients) ws.terminate()
  await new Promise((done) => sockets.close(done))
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  storage.interactions.dispose()
  storage.close()
  if (savedCert === undefined) delete process.env.SSL_CERT_FILE
  else process.env.SSL_CERT_FILE = savedCert
  rmSync(root, { recursive: true, force: true })
  console.log("CLEANUP isolated Codex process, HTTP/WebSocket service, and sandbox state closed")
}
