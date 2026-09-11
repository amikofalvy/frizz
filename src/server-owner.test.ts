import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { test, type TestContext } from "node:test"
import { writeProjectStatus } from "@frizz/server/project-launch"
import {
  acquireStableServerOwner,
  readStableServerOwner,
  stableServerOwnerAddressPath,
} from "./server-owner.ts"

const ownerUrl = pathToFileURL(join(import.meta.dirname, "server-owner.ts")).href

type Roots = { data: string; state: string }

function fixture(t: TestContext): Roots {
  const root = mkdtempSync(join(tmpdir(), "frizz-stable-server-owner-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { data: join(root, "data"), state: join(root, "state") }
}

function ownerScript(): string {
  return `
    import {
      acquireStableServerOwner,
      publishStableServerAddress,
      releaseStableServerOwner,
    } from ${JSON.stringify(ownerUrl)}
    const roots = JSON.parse(process.env.ROOTS)
    const result = acquireStableServerOwner(roots)
    if (result.kind !== "acquired") {
      console.log(JSON.stringify(result.kind === "running" ? { kind: result.kind, port: result.port } : { kind: result.kind }))
      process.exit(0)
    }
    if (process.env.PORT) publishStableServerAddress(result.lease, Number(process.env.PORT))
    console.log(JSON.stringify({ kind: "acquired", token: result.lease.token, pid: result.lease.pid, processStart: result.lease.processStart }))
    const finish = () => { releaseStableServerOwner(result.lease); process.exit(0) }
    process.once("SIGTERM", finish)
    setTimeout(finish, Number(process.env.HOLD_MS ?? 30000))
  `
}

function spawnOwner(roots: Roots, env: NodeJS.ProcessEnv = {}): { child: ChildProcess; line: Promise<Record<string, unknown>> } {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", ownerScript()], {
    cwd: process.cwd(),
    env: { ...process.env, ROOTS: JSON.stringify(roots), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const line = new Promise<Record<string, unknown>>((resolveLine, rejectLine) => {
    let stdout = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      const newline = stdout.indexOf("\n")
      if (newline >= 0) resolveLine(JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>)
    })
    child.once("exit", (code, signal) => {
      if (!stdout.includes("\n")) rejectLine(new Error(`owner child exited ${code}/${signal}: ${stderr}`))
    })
  })
  return { child, line }
}

async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill(signal)
  await exited
}

test("two stable launchers in different roots share one live owner and its published custom port", async (t) => {
  const roots = fixture(t)
  const first = spawnOwner(roots, { PORT: "49123" })
  t.after(() => stop(first.child).catch(() => undefined))
  const owner = await first.line
  assert.equal(owner.kind, "acquired")

  const second = spawnOwner(roots)
  const joined = await second.line
  await stop(second.child)
  assert.deepEqual(joined, { kind: "running", port: 49123 })
  assert.deepEqual(readStableServerOwner(roots).kind, "running")
  await stop(first.child)

  const afterRelease = spawnOwner(roots)
  t.after(() => stop(afterRelease.child).catch(() => undefined))
  assert.equal((await afterRelease.line).kind, "acquired", "only the exact owner can release the global lease")
})

test("a dead stable owner is reclaimed by an exact new generation", async (t) => {
  const roots = fixture(t)
  const first = spawnOwner(roots)
  t.after(() => stop(first.child).catch(() => undefined))
  assert.equal((await first.line).kind, "acquired")
  await stop(first.child, "SIGKILL")

  const successor = spawnOwner(roots)
  t.after(() => stop(successor.child).catch(() => undefined))
  const replacement = await successor.line
  assert.equal(replacement.kind, "acquired")
  assert.notEqual(replacement.pid, first.child.pid)
})

test("a mismatched address under a live owner fails closed instead of joining or launching a second server", async (t) => {
  const roots = fixture(t)
  const first = spawnOwner(roots, { PORT: "49124" })
  t.after(() => stop(first.child).catch(() => undefined))
  const owner = await first.line
  assert.equal(owner.kind, "acquired")
  writeProjectStatus(stableServerOwnerAddressPath(roots), {
    version: 1,
    ownerToken: randomUUID(),
    pid: owner.pid,
    processStart: owner.processStart,
    publisherToken: randomUUID(),
    port: 49124,
  })
  assert.equal(readStableServerOwner(roots).kind, "busy")

  const contender = spawnOwner(roots)
  const result = await contender.line
  await stop(contender.child)
  assert.deepEqual(result, { kind: "busy" })
})
