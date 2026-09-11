import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { endDaemonTree } from "./daemon-tree.ts"

type Spawned = Parameters<typeof endDaemonTree>[2] extends { spawnSync?: infer F } | undefined ? NonNullable<F> : never

function harness(taskkill: ReturnType<Spawned> | Error) {
  const kills: Array<[number, NodeJS.Signals]> = []
  const spawns: Array<{ file: string; args: string[]; options: Parameters<Spawned>[2] }> = []
  const spawnSync: Spawned = (file, args, options) => {
    spawns.push({ file, args, options })
    return taskkill instanceof Error ? { error: taskkill, status: null } : taskkill
  }
  return { kills, spawns, kill: (pid: number, signal: NodeJS.Signals) => { kills.push([pid, signal]) }, spawnSync }
}

test("posix: one signal to the daemon, and taskkill is never run", () => {
  const h = harness({ status: 0 })
  endDaemonTree(4242, "SIGTERM", { platform: "darwin", kill: h.kill, spawnSync: h.spawnSync })
  endDaemonTree(4242, "SIGKILL", { platform: "linux", kill: h.kill, spawnSync: h.spawnSync })
  assert.deepEqual(h.kills, [[4242, "SIGTERM"], [4242, "SIGKILL"]])
  assert.deepEqual(h.spawns, [])
})

test("win32: the daemon TREE ends through taskkill /T /F, with no window and no shell, and no signal", () => {
  // Windows audit 2026-09-11, finding 5: a signal there is TerminateProcess of the daemon alone.
  const h = harness({ status: 0 })
  endDaemonTree(4242, "SIGTERM", { platform: "win32", kill: h.kill, spawnSync: h.spawnSync })
  assert.deepEqual(h.spawns, [{ file: "taskkill", args: ["/PID", "4242", "/T", "/F"], options: { stdio: "ignore", windowsHide: true } }])
  assert.deepEqual(h.kills, [], "taskkill succeeded: the daemon is already gone")
})

test("win32: taskkill absent or refusing still ends the daemon itself", () => {
  const missing = harness(Object.assign(new Error("spawnSync taskkill ENOENT"), { code: "ENOENT" }))
  endDaemonTree(7, "SIGTERM", { platform: "win32", kill: missing.kill, spawnSync: missing.spawnSync })
  assert.deepEqual(missing.kills, [[7, "SIGTERM"]])
  const refused = harness({ status: 128 })
  endDaemonTree(8, "SIGKILL", { platform: "win32", kill: refused.kill, spawnSync: refused.spawnSync })
  assert.deepEqual(refused.kills, [[8, "SIGKILL"]])
  // A kill that throws (the pid is gone) is swallowed on both platforms.
  endDaemonTree(9, "SIGTERM", { platform: "win32", kill: () => { throw new Error("ESRCH") }, spawnSync: refused.spawnSync })
  endDaemonTree(9, "SIGTERM", { platform: "darwin", kill: () => { throw new Error("ESRCH") }, spawnSync: refused.spawnSync })
})

// Every spawn or fork of a provider process, and of the two daemons that host one, carries
// `windowsHide: true` (Windows audit 2026-09-11, finding 4). A detached daemon owns no console on
// Windows, and any console-subsystem exe it starts without CREATE_NO_WINDOW is handed a fresh
// VISIBLE one — a black `codex.exe` window per dispatch that took every Codex thread in the project
// with it when closed. None of these sites has an injectable spawn, and the daemons are separate
// processes, so the pin is on the SOURCE: each `= spawn(` / `= spawnSync(` call in these files
// carries the option somewhere inside its argument list.
test("every provider spawn and daemon fork is windowsHide", () => {
  const files = [
    "codex-app-server-daemon.ts", "codex-app-server-native.ts", "codex-quota.ts",
    "claude-broker-host.ts", "codex-app-server-host.ts", "daemon-tree.ts",
  ]
  for (const file of files) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8")
    // `= spawn(` / `= spawnSync(` assignments, and daemon-tree's own `(deps.spawnSync ?? spawnSync)(`.
    const calls = [...source.matchAll(/(?:=\s*spawn(?:Sync)?|\?\?\s*spawnSync\))\s*\(/gu)]
    assert.ok(calls.length > 0, `${file}: no spawn call site found — did the shape move?`)
    for (const m of calls) {
      // Walk to the closing paren of this call so the check covers exactly its arguments.
      let depth = 0
      let end = m.index! + m[0].length - 1
      for (; end < source.length; end++) {
        if (source[end] === "(") depth++
        else if (source[end] === ")" && --depth === 0) break
      }
      const args = source.slice(m.index, end + 1)
      assert.ok(args.includes("windowsHide: true"), `${file}: a spawn without windowsHide:\n${args.slice(0, 200)}`)
    }
  }
})
