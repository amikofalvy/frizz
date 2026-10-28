import { execFile } from "node:child_process"
import { connect } from "node:net"
import { createInterface } from "node:readline"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, fstatSync, readSync } from "node:fs"
import { join, isAbsolute, delimiter } from "node:path"
import { z } from "zod"
import type { Project } from "./project.ts"
import { workerPluginDir } from "./dispatch.ts"
import { ChildRequest, ThreadSlug, type TranscriptMessage, type TranscriptToolCall } from "@frizz/shared"
export { ChildRequest } from "@frizz/shared"

export const ChildState = z.object({
  version: z.literal(1),
  id: z.string(),
  runtime: z.enum(["claude", "codex"]),
  model: z.string(),
  effort: z.string(),
  label: z.string(),
  parent_id: z.string(),
  parent_agent_id: z.string().optional(),
  config_dir: z.string().nullable().optional(),
  permissions: z.enum(["read-only", "workspace-write", "full"]).optional(),
  run_dir: z.string(),
  socket: z.string(),
  started_at: z.string(),
  updated_at: z.string().optional(),
  finished_at: z.string().optional(),
  status: z.enum(["starting", "running", "completed", "failed", "closed"]),
  generation: z.number().int().positive(),
  completed_generation: z.number().int().nonnegative(),
  alive: z.boolean(),
  capabilities: z.object({ message: z.boolean(), stop: z.boolean(), wait: z.boolean(), resume: z.boolean().optional() }),
  result: z.string(),
  error: z.string().optional(),
  outcome: z.enum(["completed", "failed", "killed"]).optional(),
  session_id: z.string().optional(),
}).passthrough()
export type ExternalChildState = z.infer<typeof ChildState>

function directory(project: Project, slug: string) {
  ThreadSlug.parse(slug)
  return join(project.stateDir, "child-agents", slug)
}

export function externalChildren(project: Project, slug: string): ExternalChildState[] {
  if (!project?.stateDir) return []
  const root = directory(project, slug)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
    const path = join(root, entry.name, "state.json")
    if (!existsSync(path)) return []
    const state = ChildState.parse(JSON.parse(readFileSync(path, "utf8")))
    if (state.parent_id !== slug || state.id !== entry.name || state.run_dir !== join(root, entry.name)) throw new Error("Child ownership record does not match its parent")
    return [state]
  })
}

export function externalParentSlugs(project: Project): string[] {
  if (!project?.stateDir) return []
  const root = join(project.stateDir, "child-agents")
  return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : []
}

export function externalChild(project: Project, slug: string, id: string) {
  return externalChildren(project, slug).find((child) => child.id === id)
}

export function externalControl(state: ExternalChildState, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((accept, reject) => {
    const socket = connect(state.socket)
    socket.once("error", (error) => {
      if (request.action === "wait" || request.action === "stop") {
        try {
          const latest = ChildState.parse(JSON.parse(readFileSync(join(state.run_dir, "state.json"), "utf8")))
          if (!latest.alive) return accept({ state: latest })
        } catch (cause) { return reject(cause) }
      }
      reject(error)
    })
    let answered = false
    createInterface({ input: socket }).once("line", (line) => {
      answered = true
      socket.end()
      try {
        const response = z.record(z.unknown()).parse(JSON.parse(line))
        if (typeof response.error === "string") reject(new Error(response.error))
        else accept(response)
      } catch (error) { reject(error) }
    })
    socket.once("close", () => { if (!answered) reject(new Error("Child control channel closed without a receipt")) })
    socket.once("connect", () => socket.write(`${JSON.stringify({ version: 1, ...request })}\n`))
  })
}

const launches = new Map<string, { payload: string; result: Promise<ExternalChildState> }>()
const closing = new Set<string>()

function invokeHelper(project: Project, slug: string, id: string, helper: string, payload: Record<string, unknown>): Promise<ExternalChildState> {
  return new Promise((accept, reject) => {
    const processHandle = execFile(process.execPath, [helper, "--host"], { cwd: project.dir, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`Child operation failed: ${stderr || error.message}`))
      try {
        const receipt = ChildState.parse(JSON.parse(stdout))
        const recorded = externalChild(project, slug, id)
        if (!recorded || receipt.id !== id || receipt.parent_id !== slug || receipt.run_dir !== recorded.run_dir) throw new Error("Receipt is not bound to the recorded child")
        accept(recorded)
      } catch (cause) { reject(new Error("Child helper returned an invalid receipt", { cause })) }
    })
    processHandle.stdin?.end(JSON.stringify(payload))
  })
}

export function externalLineage(child: ExternalChildState, children: readonly ExternalChildState[]): string[] {
  const ids = new Set([child.id])
  const lineage: string[] = []
  let parent = child.parent_agent_id
  while (parent) {
    if (ids.has(parent)) throw new Error("Cyclic child-agent ownership record")
    ids.add(parent)
    lineage.push(parent)
    parent = children.find((candidate) => candidate.id === parent)?.parent_agent_id
  }
  return lineage
}

export async function stopExternalSubtree(project: Project, slug: string, id: string) {
  const children = externalChildren(project, slug)
  const parent = children.find((child) => child.id === id)
  if (!parent) throw new Error("Child does not belong to this thread")
  if (children.some((child) => child.alive && (child.id === id || externalLineage(child, children).includes(id)) && !child.capabilities.stop)) throw new Error("A runtime in this branch does not support stopping")
  const key = `${project.id}:${slug}:${id}`
  closing.add(key)
  writeFileSync(join(parent.run_dir, "closing"), "closing", { mode: 0o600 })
  try {
    const root = directory(project, slug) + "/"
    await Promise.allSettled([...launches.entries()].filter(([path]) => path.startsWith(root)).map(([, launch]) => launch.result))
    const current = externalChildren(project, slug)
    const descendants = current.filter((child) => externalLineage(child, current).includes(id))
    const owner = current.find((child) => child.id === id)
    if (!owner) throw new Error("The stopping child's ownership record disappeared")
    if (current.some((child) => child.alive && (child.id === id || descendants.includes(child)) && !child.capabilities.stop)) throw new Error("A runtime in this branch does not support stopping")
    if (owner.alive) await externalControl(owner, { action: "stop" })
    let stopped = 0
    for (const child of descendants.sort((a, b) => externalLineage(b, current).length - externalLineage(a, current).length)) {
      if (child.alive) { await externalControl(child, { action: "stop" }); stopped++ }
    }
    writeFileSync(join(parent.run_dir, "closing"), "closed", { mode: 0o600 })
    return { state: externalChild(project, slug, id), descendantsStopped: stopped }
  } finally { closing.delete(key) }
}

interface ChildHostRuntime {
  helper?: string
  claudeBin?: string
  codexBin?: string
}

function hostRuntime(runtime: "claude" | "codex", options: ChildHostRuntime) {
  if (process.platform === "win32" && !options.helper) throw new Error("Child-agent protocol v1 requires macOS or Linux")
  const plugin = options.helper ? undefined : workerPluginDir()
  const helper = options.helper ?? (plugin ? join(plugin, "lib", "child-agent.mjs") : undefined)
  if (!helper || !existsSync(helper)) throw new Error("Frizz's bundled child-agent runtime is unavailable")
  const selected = (runtime === "claude" ? options.claudeBin : options.codexBin) ?? runtime
  const executable = isAbsolute(selected) ? selected : (process.env.PATH ?? "").split(delimiter).map((part) => join(part, selected)).find((path) => existsSync(path))
  if (!executable) throw new Error("Frizz's configured native runtime is unavailable")
  const store = process.env[runtime === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] || null
  if (store && !isAbsolute(store)) throw new Error("The host's native config store must be an absolute path")
  return { helper, executable, store, callback: plugin ? [join(plugin, "bin", "frizzctl"), "child", "--input", "-"] : undefined }
}

export async function operateChild(project: Project, slug: string, input: z.infer<typeof ChildRequest>, options: ChildHostRuntime = {}): Promise<unknown> {
  const request = ChildRequest.parse(input)
  delete request.helper
  delete request.host_argv
  if (request.action === "list") return { children: externalChildren(project, slug) }
  if (!request.id) throw new Error("A child id is required")
  const childId = request.id
  const root = directory(project, slug)
  const runDir = join(root, request.id)
  if (request.action === "start") {
    for (const key of ["model", "effort", "prompt", "cwd"] as const) if (!request[key]) throw new Error(`${key} is required`)
    const runtime = request.runtime
    if (!runtime) throw new Error("runtime is required")
    const permission = request.permissions
    if (!permission) throw new Error("permissions is required")
    if (!request.cwd || !isAbsolute(request.cwd)) throw new Error("Child cwd must be absolute")
    if (request.parent_agent_id) {
      const parent = externalChild(project, slug, request.parent_agent_id)
      if (request.parent_agent_id === request.id || !parent || !parent.alive) throw new Error("Parent agent does not belong to this thread or has closed")
      const authority = { "read-only": 1, "workspace-write": 2, full: 3 }
      if (authority[permission] > authority[parent.permissions ?? "read-only"]) throw new Error("Child permissions exceed the parent agent's grant")
      if ([parent.id, ...externalLineage(parent, externalChildren(project, slug))].some((id) => closing.has(`${project.id}:${slug}:${id}`) || existsSync(join(root, id, "closing")))) throw new Error("The parent agent's subtree is stopping")
    }
    const host = hostRuntime(runtime, options)
    if (request.executable && request.executable !== host.executable) throw new Error("The native executable is selected by Frizz, not the child request")
    if (request.config_dir !== undefined && request.config_dir !== host.store) throw new Error("The native config store is selected by Frizz, not the child request")
    const payload = { ...request, helper: host.helper, executable: host.executable, config_dir: host.store, parent_id: slug, run_dir: runDir, ...(host.callback ? { host_argv: host.callback, host_env: { FRIZZ_THREAD_SLUG: slug, FRIZZ_PROJECT_ID: project.id, FRIZZ_STATE_DIR: project.stateDir, FRIZZ_NODE: process.execPath } } : {}) }
    const existing = externalChild(project, slug, request.id)
    if (existing) {
      const recorded = JSON.parse(readFileSync(join(runDir, "request.json"), "utf8")) as Record<string, unknown>
      const intent = { ...request, config_dir: host.store, parent_id: slug, run_dir: runDir }
      if (Object.entries(intent).some(([key, value]) => JSON.stringify(recorded[key]) !== JSON.stringify(value))) throw new Error("Child id was already used for a different launch")
      return existing
    }
    const inFlight = launches.get(runDir)
    if (inFlight) {
      if (inFlight.payload !== JSON.stringify(payload)) throw new Error("Child id is already launching with a different request")
      return inFlight.result
    }
    if (existsSync(runDir)) throw new Error(`Child launch has an unresolved record at ${runDir}; inspect it before creating another writer`)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const launch = invokeHelper(project, slug, childId, host.helper, payload)
    launches.set(runDir, { payload: JSON.stringify(payload), result: launch })
    try { return await launch } finally { launches.delete(runDir) }
  }
  const state = externalChild(project, slug, request.id)
  if (!state) throw new Error("Child does not belong to this thread")
  if (request.action === "status") return state
  if (request.action === "stop") return stopExternalSubtree(project, slug, request.id)
  if (request.action === "resume") {
    if (!state.capabilities.resume || !state.permissions) throw new Error("Recorded child lacks safe resume metadata")
    if (closing.has(`${project.id}:${slug}:${state.id}`)) throw new Error("The child's branch is still stopping")
    if (state.parent_agent_id) {
      const parent = externalChild(project, slug, state.parent_agent_id)
      if (!parent?.alive) throw new Error("Resume the owning parent agent before this descendant")
    }
    for (const key of ["runtime", "model", "effort", "permissions"] as const) if (request[key] !== undefined && request[key] !== state[key]) throw new Error("Resume preserves the recorded runtime profile and grant")
    const host = hostRuntime(state.runtime, options)
    if (state.config_dir !== undefined && state.config_dir !== host.store) throw new Error("The recorded config store differs from the host's selected native store")
    const payload = { version: 1, action: "resume", id: state.id, run_dir: state.run_dir, request_id: request.request_id, text: request.text }
    const inFlight = launches.get(runDir)
    if (inFlight) {
      if (inFlight.payload !== JSON.stringify(payload)) throw new Error("Another child operation is already in flight")
      return inFlight.result
    }
    const resumed = invokeHelper(project, slug, state.id, host.helper, payload)
    launches.set(runDir, { payload: JSON.stringify(payload), result: resumed })
    try { return await resumed } finally { launches.delete(runDir) }
  }
  if ((request.action === "message" && !state.capabilities.message) || (request.action === "wait" && !state.capabilities.wait)) throw new Error("This child does not support the requested control")
  if (!state.alive && request.action === "wait") return { state }
  if (!state.alive) throw new Error("Child runtime has closed; its terminal record remains available")
  return externalControl(state, request)
}

const ChildEvent = z.object({
  version: z.literal(1), seq: z.number(), at: z.string(), kind: z.string(),
  role: z.enum(["assistant", "user"]).optional(), text: z.string().optional(), name: z.string().optional(),
  id: z.string().optional(), input: z.string().optional(), output: z.string().optional(), status: z.enum(["completed", "failed"]).optional(),
})

export function externalTranscript(state: ExternalChildState): TranscriptMessage[] {
  const path = join(state.run_dir, "events.jsonl")
  if (!existsSync(path)) return []
  const file = openSync(path, "r")
  let text: string
  try {
    const size = fstatSync(file).size
    const length = Math.min(size, 1024 * 1024)
    const bytes = Buffer.alloc(length)
    const count = readSync(file, bytes, 0, length, size - length)
    text = bytes.subarray(0, count).toString("utf8")
    if (size > length) text = text.slice(text.indexOf("\n") + 1)
  } finally { closeSync(file) }
  const tools = new Map<string, TranscriptToolCall>()
  const messages = text.split("\n").slice(0, -1).slice(-500).map((line) => ChildEvent.parse(JSON.parse(line))).flatMap((event): TranscriptMessage[] => {
    if (event.kind === "message" && event.role && event.text !== undefined) return [{ sourceId: `${state.id}:${event.seq}`, role: event.role, text: event.text, tools: [], parts: [{ kind: "text", text: event.text }], at: event.at }]
    if (event.kind === "tool" && event.name) {
      const tool: TranscriptToolCall = { name: event.name, input: event.input, status: "pending" }
      if (event.id) tools.set(event.id, tool)
      return [{ sourceId: `${state.id}:${event.seq}`, role: "assistant", text: "", tools: [tool], parts: [{ kind: "tools", tools: [tool] }], at: event.at }]
    }
    if (event.kind === "tool-result" && event.id) {
      const tool = tools.get(event.id)
      if (tool) { tool.output = event.output; tool.status = event.status ?? "completed" }
    }
    return []
  })
  const coalesced: TranscriptMessage[] = []
  for (const message of messages) {
    const previous = coalesced.at(-1)
    if (previous && previous.role === message.role && !previous.tools.length && !message.tools.length) {
      previous.text += message.text
      previous.parts = [{ kind: "text", text: previous.text }]
    } else coalesced.push(message)
  }
  return coalesced
}

export function externalDispatches(project: Project, slug: string): TranscriptMessage[] {
  return externalChildren(project, slug).sort((a, b) => a.started_at.localeCompare(b.started_at)).slice(-32).map((child) => {
    const settled = child.status !== "running" && child.status !== "starting"
    const outcome = child.outcome ?? (child.status === "completed" ? "completed" : child.status === "closed" ? "killed" : "failed")
    const tool = {
      name: "ExternalAgent", detail: child.label, agentId: `external_${child.id}`,
      subagentType: `${child.runtime} ${child.model}/${child.effort}`,
      status: settled ? "completed" as const : "pending" as const,
      ...(settled ? { agentStatus: outcome } : {}),
      ...(child.finished_at ? { agentElapsedMs: Date.parse(child.finished_at) - Date.parse(child.started_at) } : {}),
    }
    return { sourceId: `external-agent:${child.id}`, role: "assistant" as const, text: "", tools: [tool], parts: [{ kind: "tools" as const, tools: [tool] }], at: child.started_at }
  })
}
