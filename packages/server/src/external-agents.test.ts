import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import { createInterface } from "node:readline"
import { externalChildren, externalTranscript, externalControl, externalDispatches, externalLineage, stopExternalSubtree, operateChild, type ExternalChildState } from "./external-agents.ts"
import type { Project } from "./project.ts"
import { createStorage } from "./storage.ts"
import { createTailer } from "./tailer.ts"
import { Bus } from "./bus.ts"
import { createRouter } from "./router.ts"
import type { AppContext } from "./context.ts"
import { frizzCliEnv } from "./backend/types.ts"

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-child-"))
  const project: Project = { dir, stateDir: dir, id: "test", cwdSlug: "test", name: "test", label: "test" }
  const run = join(dir, "child-agents", "parent", "child")
  mkdirSync(run, { recursive: true })
  const state: ExternalChildState = { version: 1, id: "child", parent_id: "parent", runtime: "codex", model: "test", effort: "low", label: "Reviewing files", run_dir: run, socket: join(dir, "control.sock"), started_at: "2026-10-28T00:00:00.000Z", updated_at: new Date().toISOString(), status: "running", generation: 1, completed_generation: 0, alive: true, capabilities: { message: true, stop: true, wait: true }, result: "" }
  const save = () => writeFileSync(join(run, "state.json"), JSON.stringify(state))
  save()
  return { dir, project, run, state, save }
}

test("child records are parent-scoped and foreign ownership is refused", (t) => {
  const h = fixture()
  t.after(() => rmSync(h.dir, { recursive: true, force: true }))
  assert.equal(externalChildren(h.project, "parent")[0].runtime, "codex")
  assert.deepEqual(externalChildren(h.project, "another-parent"), [])
  h.state.parent_id = "another-parent"; h.save()
  assert.deepEqual(externalChildren(h.project, "parent"), [])
  assert.throws(() => externalChildren(h.project, "parent", true), /ownership/)
});

test("an unreadable child is isolated from healthy children and the parent's tailer", (t) => {
  const h = fixture()
  const storage = createStorage(join(h.dir, "ui.db"), "test")
  t.after(() => { storage.close(); rmSync(h.dir, { recursive: true, force: true }) })
  const bad = join(h.dir, "child-agents", "parent", "bad")
  mkdirSync(bad); writeFileSync(join(bad, "state.json"), '{"version":2}')
  mkdirSync(join(h.dir, "child-agents", "not a thread"))
  storage.upsertSession({ slug: "parent", session_id: "sid", thread_name: "frizz-parent", spawned_at: h.state.started_at, last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: "parent", state: "open", meta: null, seen_at: null, transcript_id: null })
  writeFileSync(join(h.dir, "sid.jsonl"), JSON.stringify({ type: "assistant", timestamp: h.state.started_at, message: { role: "assistant", content: [{ type: "text", text: "Waiting" }], stop_reason: "end_turn" } }) + "\n")
  const tailer = createTailer({ project: h.project, storage, bus: new Bus(), sessionLogDir: h.dir, paneDead: () => false, onChange: () => {} })
  tailer.tick()
  assert.equal(tailer.get("parent")?.subAgents[0]?.taskId, "child")
  assert.equal(externalDispatches(h.project, "parent").length, 1)
  assert.throws(() => externalChildren(h.project, "parent", true))
});

test("heartbeats update liveness without republishing the parent transcript", (t) => {
  const h = fixture()
  const storage = createStorage(join(h.dir, "ui.db"), "test")
  t.after(() => { storage.close(); rmSync(h.dir, { recursive: true, force: true }) })
  storage.upsertSession({ slug: "parent", session_id: "sid", thread_name: "frizz-parent", spawned_at: h.state.started_at, last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: "parent", state: "open", meta: null, seen_at: null, transcript_id: null })
  writeFileSync(join(h.dir, "sid.jsonl"), JSON.stringify({ type: "assistant", timestamp: h.state.started_at, message: { role: "assistant", content: [{ type: "text", text: "Waiting" }], stop_reason: "end_turn" } }) + "\n")
  let pushes = 0
  const tailer = createTailer({ project: h.project, storage, bus: new Bus(), sessionLogDir: h.dir, paneDead: () => false, onChange: () => {}, onTranscriptChange: () => { pushes++ } })
  tailer.tick()
  const initial = pushes
  h.state.updated_at = new Date(0).toISOString(); h.save(); tailer.tick()
  assert.equal(tailer.get("parent")?.subAgents[0]?.state, "stale")
  assert.equal(pushes, initial)
  h.state.updated_at = new Date().toISOString(); h.save(); tailer.tick()
  assert.equal(tailer.get("parent")?.subAgents[0]?.state, "running")
  assert.equal(pushes, initial)
});

test("settled portable children do not evict native retired drawers", (t) => {
  const h = fixture()
  const storage = createStorage(join(h.dir, "ui.db"), "test")
  t.after(() => { storage.close(); rmSync(h.dir, { recursive: true, force: true }) })
  storage.upsertSession({ slug: "parent", session_id: "sid", thread_name: "frizz-parent", spawned_at: h.state.started_at, last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: "parent", state: "open", meta: null, seen_at: null, transcript_id: null })
  const records = [
    { type: "assistant", timestamp: h.state.started_at, message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Agent", id: "native-task", input: { description: "Native review", run_in_background: true } }] } },
    { type: "queue-operation", operation: "enqueue", timestamp: h.state.started_at, content: "<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>native-task</tool-use-id>\n<status>completed</status>\n</task-notification>" },
  ]
  writeFileSync(join(h.dir, "sid.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n")
  const tailer = createTailer({ project: h.project, storage, bus: new Bus(), sessionLogDir: h.dir, paneDead: () => false, onChange: () => {} })
  tailer.tick()
  assert(tailer.subAgent("parent", "native-task"))
  for (let index = 0; index < 25; index++) {
    const id = `old-${index}`
    const run_dir = join(h.dir, "child-agents", "parent", id)
    mkdirSync(run_dir)
    writeFileSync(join(run_dir, "state.json"), JSON.stringify({ ...h.state, id, run_dir, status: "completed", finished_at: h.state.started_at }))
  }
  tailer.tick()
  assert(tailer.subAgent("parent", "native-task"))
  h.state.result = "stream update"; h.save(); tailer.tick()
  assert(tailer.subAgent("parent", "native-task"))
});

test("a stale missing controller can be marked lost without claiming closure or permitting resume", { skip: process.platform === "win32" }, async (t) => {
  const h = fixture()
  t.after(() => rmSync(h.dir, { recursive: true, force: true }))
  await assert.rejects(stopExternalSubtree(h.project, "parent", "child"), /ENOENT/)
  assert.equal(externalChildren(h.project, "parent")[0].lost, undefined)
  h.state.updated_at = new Date(0).toISOString(); h.save()
  const result = await stopExternalSubtree(h.project, "parent", "child")
  assert.equal(result.state?.lost, true)
  assert.equal(result.state?.status, "failed")
  assert.equal(result.state?.capabilities.resume, false)
  assert.match(result.state?.error ?? "", /closure.*unverified/)
  assert.equal(readFileSync(join(h.run, "closing"), "utf8"), "closed")
  await assert.rejects(operateChild(h.project, "parent", { version: 1, action: "resume", id: "child", request_id: "unsafe", text: "continue" }), /safe resume/)
});

test("runtime deltas become one readable child message, separated by actual tools", (t) => {
  const h = fixture()
  t.after(() => rmSync(h.dir, { recursive: true, force: true }))
  const events = [{ kind: "message", role: "assistant", text: "hello " }, { kind: "message", role: "assistant", text: "world" }, { kind: "tool", id: "read", name: "Read", input: "file.txt" }, { kind: "tool-result", id: "read", output: "contents", status: "completed" }, { kind: "message", role: "assistant", text: "finished" }]
  writeFileSync(join(h.run, "events.jsonl"), events.map((event, seq) => JSON.stringify({ version: 1, seq, at: h.state.started_at, ...event })).join("\n") + "\n")
  const messages = externalTranscript(h.state)
  assert.equal(messages.length, 3)
  assert.equal(messages[0].text, "hello world")
  assert.deepEqual(messages[0].parts, [{ kind: "text", text: "hello world" }])
  assert.equal(messages[1].tools[0].name, "Read")
  assert.equal(messages[1].tools[0].input, "file.txt")
  assert.equal(messages[1].tools[0].output, "contents")
  assert.equal(messages[1].tools[0].status, "completed")
});

test("controls use the exact child's channel and distinguish an acceptance receipt from failure", { skip: process.platform === "win32" ? "Protocol v1 uses Unix sockets" : false }, async (t) => {
  const h = fixture()
  const requests: unknown[] = []
  const server = createServer((socket) => createInterface({ input: socket }).once("line", (line) => {
    requests.push(JSON.parse(line))
    socket.end(JSON.stringify({ delivery: "accepted" }) + "\n")
  }))
  await new Promise<void>((accept) => server.listen(h.state.socket, accept))
  t.after(async () => { await new Promise<void>((accept) => server.close(() => accept())); rmSync(h.dir, { recursive: true, force: true }) })
  assert.deepEqual(await externalControl(h.state, { action: "message", text: "direction", request_id: "once" }), { delivery: "accepted" })
  assert.deepEqual(requests, [{ version: 1, action: "message", text: "direction", request_id: "once" }])
  await assert.rejects(operateChild(h.project, "another-parent", { version: 1, action: "stop", id: "child" }), /does not belong/)
});

test("the real tailer tracks a foreign-harness child through completion and server reconstruction", (t) => {
  const h = fixture()
  const storage = createStorage(join(h.dir, "ui.db"), "test")
  t.after(() => { storage.close(); rmSync(h.dir, { recursive: true, force: true }) })
  storage.upsertSession({ slug: "parent", session_id: "sid", thread_name: "frizz-parent", spawned_at: h.state.started_at, last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: "parent", state: "open", meta: null, seen_at: null, transcript_id: null })
  writeFileSync(join(h.dir, "sid.jsonl"), JSON.stringify({ type: "assistant", timestamp: h.state.started_at, message: { role: "assistant", content: [{ type: "text", text: "Waiting" }], stop_reason: "end_turn" } }) + "\n")
  const make = () => createTailer({ project: h.project, storage, bus: new Bus(), sessionLogDir: h.dir, paneDead: () => false, onChange: () => {} })
  const tailer = make()
  tailer.tick()
  assert.equal(tailer.get("parent")?.subAgents[0]?.taskId, "child")
  assert.match(tailer.get("parent")?.subAgents[0]?.subagentType ?? "", /^codex /)
  h.state.updated_at = new Date(0).toISOString(); h.save()
  tailer.tick()
  assert.equal(tailer.get("parent")?.subAgents[0]?.state, "stale")
  h.state.updated_at = new Date().toISOString(); h.save()
  const dispatch = externalDispatches(h.project, "parent")[0]
  assert.equal(dispatch.tools[0].name, "ExternalAgent")
  assert.equal(dispatch.tools[0].agentId, "external_child")
  h.state.status = "completed"; h.state.finished_at = "2026-10-28T00:01:00.000Z"; h.save()
  tailer.tick()
  assert.equal(tailer.get("parent")?.subAgents.length, 0)
  assert.equal(tailer.get("parent")?.retiredSubAgents?.[0]?.status, "completed")
  const restarted = make()
  restarted.tick()
  assert.equal(restarted.get("parent")?.retiredSubAgents?.[0]?.taskId, "child")
  assert.equal(externalDispatches(h.project, "parent")[0].tools[0].agentStatus, "completed")
  const run = join(h.dir, "child-agents", "parent", "leaf")
  mkdirSync(run)
  const leaf = { ...h.state, id: "leaf", run_dir: run, parent_agent_id: "child", status: "running", finished_at: undefined }
  writeFileSync(join(run, "state.json"), JSON.stringify(leaf))
  restarted.tick()
  const branch = restarted.get("parent")?.subAgents ?? []
  assert.equal(branch.find((child) => child.taskId === "child")?.state, "rested")
  assert.equal(branch.find((child) => child.taskId === "leaf")?.depth, 2)
  assert.equal(branch.find((child) => child.taskId === "leaf")?.parentId, "external_child")
  h.state.session_id = "managed-native"; h.save()
  writeFileSync(join(h.dir, "managed-native.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Owned child" }], stop_reason: "end_turn" } }) + "\n")
  writeFileSync(join(h.dir, "unmanaged-native.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Unowned control" }], stop_reason: "end_turn" } }) + "\n")
  const rescanned = make()
  rescanned.tick()
  assert(!rescanned.foreignIds().includes("managed-native"))
  assert(rescanned.foreignIds().includes("unmanaged-native"))
});

test("stopping a branch blocks new descendants before closing its independently owned runtimes", { skip: process.platform === "win32" ? "Protocol v1 uses Unix sockets" : false }, async (t) => {
  const h = fixture()
  const leafDir = join(h.dir, "child-agents", "parent", "leaf")
  mkdirSync(leafDir)
  const leaf: ExternalChildState = { ...h.state, id: "leaf", parent_agent_id: "child", run_dir: leafDir, socket: join(h.dir, "leaf.sock") }
  writeFileSync(join(leafDir, "state.json"), JSON.stringify(leaf))
  assert.deepEqual(externalLineage(leaf, [h.state, leaf]), ["child"])
  const order: string[] = []
  let spawnRejected = false
  const servers = [h.state, leaf].map((child) => createServer((socket) => createInterface({ input: socket }).once("line", async () => {
    order.push(child.id)
    if (child.id === "child") {
      try { await operateChild(h.project, "parent", { version: 1, action: "start", id: "new", parent_agent_id: "child", runtime: "codex", model: "test", effort: "low", permissions: "read-only", prompt: "task", cwd: h.dir, helper: "/not-started.mjs" }) }
      catch (error) { spawnRejected = String(error).includes("stopping") }
    }
    child.alive = false
    child.status = "closed"
    writeFileSync(join(child.run_dir, "state.json"), JSON.stringify(child))
    socket.end(JSON.stringify({ state: child }) + "\n")
  })))
  await Promise.all(servers.map((server, index) => new Promise<void>((accept) => server.listen([h.state, leaf][index].socket, accept))))
  t.after(async () => { await Promise.all(servers.map((server) => new Promise<void>((accept) => server.close(() => accept())))); rmSync(h.dir, { recursive: true, force: true }) })
  const result = await stopExternalSubtree(h.project, "parent", "child")
  assert.equal(spawnRejected, true)
  assert.deepEqual(order, ["child", "leaf"])
  assert.equal(result.descendantsStopped, 1)
});

test("concurrent launch retries share one accepted writer and changed intent is refused", async (t) => {
  const h = fixture()
  t.after(() => rmSync(h.dir, { recursive: true, force: true }))
  const helper = join(h.dir, "helper.mjs")
  const counter = join(h.dir, "starts")
  writeFileSync(helper, `import fs from 'node:fs';import{join}from'node:path';let text='';for await(const data of process.stdin)text+=data;const r=JSON.parse(text);fs.appendFileSync(${JSON.stringify(counter)},'start\\n');fs.mkdirSync(r.run_dir);fs.writeFileSync(join(r.run_dir,'request.json'),JSON.stringify({...r,derivedMetadata:true}));const s={version:1,id:r.id,parent_id:r.parent_id,runtime:r.runtime,model:r.model,effort:r.effort,label:r.id,run_dir:r.run_dir,socket:join(r.run_dir,'control'),started_at:new Date().toISOString(),status:'completed',generation:1,completed_generation:1,alive:false,capabilities:{message:false,stop:false,wait:true},result:'done'};fs.writeFileSync(join(r.run_dir,'state.json'),JSON.stringify(s));process.stdout.write(JSON.stringify(s));`)
  const request = { version: 1 as const, action: "start" as const, id: "new", runtime: "codex" as const, model: "test", effort: "low", permissions: "read-only" as const, prompt: "task", cwd: h.dir, helper: "/untrusted/worker-helper.mjs" }
  const host = { helper, codexBin: process.execPath }
  const first = operateChild(h.project, "parent", request, host)
  const repeated = operateChild(h.project, "parent", request, host)
  await assert.rejects(operateChild(h.project, "parent", { ...request, prompt: "different" }, host), /different request/)
  assert.deepEqual(await first, await repeated)
  assert.deepEqual(await operateChild(h.project, "parent", request, host), await first)
  await assert.rejects(operateChild(h.project, "parent", { ...request, id: "malicious", executable: "/untrusted/program" }, host), /selected by Frizz/)
  assert(!readFileSync(join(h.run, "state.json"), "utf8").includes("untrusted"))
  assert.equal(readFileSync(counter, "utf8"), "start\n")
});

test("the host advertises the portable capability only on supported platforms", () => {
  const cli = { binDir: "/plugin/bin", stateDir: "/private/state" }
  assert.equal(frizzCliEnv(cli, "parent", "/node", "darwin").FRIZZ_CHILD_AGENTS_PROTOCOL, "1")
  assert.equal(frizzCliEnv(cli, "parent", "C:/node.exe", "win32").FRIZZ_CHILD_AGENTS_PROTOCOL, undefined)
});

test("the RPC refuses child grants broader than the current parent policy", async (t) => {
  const h = fixture()
  const storage = createStorage(join(h.dir, "ui.db"), "test")
  t.after(() => { storage.close(); rmSync(h.dir, { recursive: true, force: true }) })
  storage.upsertSession({ slug: "parent", session_id: "sid", thread_name: "frizz-parent", spawned_at: h.state.started_at, last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: "parent", state: "open", meta: null, seen_at: null, transcript_id: null })
  let permission = "auto"
  const router = createRouter({ project: h.project, storage, tailer: { get: () => ({ permissionMode: permission }) }, getSettings: () => ({ permissionMode: permission }) } as unknown as AppContext)
  const request = { version: 1 as const, action: "start" as const, id: "new", runtime: "codex" as const, model: "test", effort: "low", permissions: "full" as const, prompt: "task", cwd: h.dir, helper: "/not-started.mjs" }
  await assert.rejects(router.ownChildAgent.handler({ input: { slug: "parent", request } }), /bypass grant/)
  permission = "plan"
  await assert.rejects(router.ownChildAgent.handler({ input: { slug: "parent", request: { ...request, permissions: "workspace-write" } } }), /read-only parent/)
  await assert.rejects(operateChild(h.project, "parent", { ...request, parent_agent_id: "child" }), /exceed/)
});
