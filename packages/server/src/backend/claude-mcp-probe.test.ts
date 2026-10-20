import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClaudeMcpProbe } from "./claude-mcp-probe.ts"
import type { ClaudeQueryFactory, ClaudeQueryHandle, ClaudeQueryStartOptions } from "./claude-agent-sdk.ts"
import type { ClaudeMcpServerReading } from "./claude-agent-sdk-protocol.ts"

// A project whose `.mcp.json` is approved, and a Claude config dir of its own, so no test reads the
// operator's real `~/.claude.json`.
function project(servers: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "frizz-mcp-probe-"))
  const dir = join(root, "repo")
  mkdirSync(join(dir, ".claude"), { recursive: true })
  mkdirSync(join(root, "claude-config"))
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ enableAllProjectMcpServers: true }))
  const declare = (next: Record<string, unknown>) => writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: next }))
  declare(servers)
  return { dir, declare, env: { CLAUDE_CONFIG_DIR: join(root, "claude-config") } }
}

// A CLI session that never runs a turn: it answers status reads from `reading` and ends when closed.
function fakeFactory(reading: (call: number) => ClaudeMcpServerReading[]) {
  const started: Array<{ options: ClaudeQueryStartOptions; closed: () => boolean }> = []
  const factory: ClaudeQueryFactory = {
    start(options) {
      let closed = false
      let end: (() => void) | undefined
      let calls = 0
      const handle = {
        async mcpServerStatus() { return reading(calls++) },
        async mcpAuthenticate() { return { authUrl: "https://auth.example/authorize", requiresUserAction: true, callbackPort: 61234 } },
        async close() { closed = true; end?.() },
        async *[Symbol.asyncIterator]() { if (!closed) await new Promise<void>((resolve) => { end = resolve }) },
      }
      started.push({ options, closed: () => closed })
      return handle as unknown as ClaudeQueryHandle
    },
  }
  return { factory, started }
}

const NOTION = { type: "http", url: "https://mcp.notion.com/mcp" }
const LOCAL = { command: "node", args: ["local-mcp.mjs"] }

test("only the remote servers start a session, and stdio servers are listed from the config as connected", async () => {
  const p = project({ notion: NOTION, local: LOCAL })
  // A fresh CLI says `pending` until the handshake lands; the read waits for it to settle.
  const { factory, started } = fakeFactory((call) => [{ name: "notion", status: call === 0 ? "pending" : "needs-auth", remote: true }])
  const probe = createClaudeMcpProbe({ projectDir: p.dir, executablePath: "claude", env: p.env, factory })
  assert.deepEqual(await probe.status(), [
    { name: "notion", status: "needs-auth", remote: true },
    { name: "local", status: "connected", remote: false },
  ])
  assert.equal(started.length, 1)
  const options = started[0]!.options
  assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["notion"], "the stdio server is never started")
  assert.equal(options.strictMcpConfig, true)
  assert.equal(options.persistSession, false)
  assert.deepEqual(options.settingSources, [])
  await probe.status()
  assert.equal(started.length, 1, "the session is reused while the remote list stays the same")
  await probe.close()
  assert.equal(started[0]!.closed(), true)
})

test("a changed remote list restarts the session, and a project with none needs no session", async () => {
  const p = project({ notion: NOTION, local: LOCAL })
  const { factory, started } = fakeFactory(() => [{ name: "notion", status: "connected", remote: true, tools: 12 }])
  const probe = createClaudeMcpProbe({ projectDir: p.dir, executablePath: "claude", env: p.env, factory })
  await probe.status()
  p.declare({ notion: NOTION, linear: { type: "http", url: "https://mcp.linear.app/mcp" }, local: LOCAL })
  const rows = await probe.status()
  assert.equal(started.length, 2)
  assert.equal(started[0]!.closed(), true, "the old session is closed")
  assert.deepEqual(rows.find((row) => row.name === "linear"), { name: "linear", status: "pending", remote: true }, "a server the CLI has not reported yet reads pending")
  p.declare({ local: LOCAL })
  assert.deepEqual(await probe.status(), [{ name: "local", status: "connected", remote: false }])
  assert.equal(started.length, 2)
  assert.equal(started[1]!.closed(), true)
  await probe.close()
})

test("a sign-in holds the session past its idle timeout until it is released", async () => {
  const p = project({ notion: NOTION, local: LOCAL })
  const { factory, started } = fakeFactory(() => [{ name: "notion", status: "needs-auth", remote: true }])
  const probe = createClaudeMcpProbe({ projectDir: p.dir, executablePath: "claude", env: p.env, factory, idleMs: 30 })
  await assert.rejects(probe.authenticate("local"), /not a remote MCP server/)
  assert.equal((await probe.authenticate("notion")).authUrl, "https://auth.example/authorize")
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.equal(started[0]!.closed(), false, "held open while the sign-in waits")
  assert.equal((await probe.serverStatus("notion"))?.status, "needs-auth")
  probe.release("notion")
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.equal(started[0]!.closed(), true, "idle once released")
  assert.equal(await probe.serverStatus("notion"), undefined, "no session, so nothing to read")
  await probe.close()
})
