import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreadSlug } from "@frizz/shared"
import { createLoginUtility } from "./login-utility.ts"

// A fake node-pty. Enough surface for the utility: data/exit subscriptions, write, resize, kill.
interface FakePty {
  file: string
  args: string[]
  cwd: string
  killed: boolean
  written: string[]
  resized: [number, number][]
  emit(chunk: string): void
  exit(): void
}

function harness(over: { lifetimeMs?: number; claudeBin?: string; codexBin?: string; env?: NodeJS.ProcessEnv; spawnThrows?: string } = {}) {
  const spawned: FakePty[] = []
  const utility = createLoginUtility({
    claudeBin: over.claudeBin ?? "/stub/claude",
    codexBin: over.codexBin ?? "/stub/codex",
    cwd: "/project",
    lifetimeMs: over.lifetimeMs ?? 60_000,
    ...(over.env ? { env: over.env } : {}),
    spawnPty: ((file: string, args: string[], opts: { cwd: string }) => {
      if (over.spawnThrows) throw new Error(over.spawnThrows)
      const dataListeners: ((c: string) => void)[] = []
      const exitListeners: (() => void)[] = []
      const fake: FakePty = {
        file, args, cwd: opts.cwd, killed: false, written: [], resized: [],
        emit: (chunk) => dataListeners.forEach((l) => l(chunk)),
        exit: () => exitListeners.forEach((l) => l()),
      }
      spawned.push(fake)
      return {
        onData: (l: (c: string) => void) => void dataListeners.push(l),
        onExit: (l: () => void) => void exitListeners.push(l),
        write: (d: string) => void fake.written.push(d),
        resize: (c: number, r: number) => void fake.resized.push([c, r]),
        kill: () => { fake.killed = true },
      }
    }) as never,
  })
  return { utility, spawned }
}

test("start spawns exactly the provider login argv, no shell, addressed by a slug-shaped opaque id", () => {
  const h = harness()
  const { attemptId } = h.utility.start("claude")
  assert.match(attemptId, /^login-[0-9a-f]{16}$/)
  assert.equal(ThreadSlug.safeParse(attemptId).success, true, "the id must ride the /term slug transport")
  assert.equal(h.spawned.length, 1)
  assert.equal(h.spawned[0]!.file, "/stub/claude")
  assert.deepEqual(h.spawned[0]!.args, ["auth", "login"])
  assert.equal(h.spawned[0]!.cwd, "/project")
})

test("codex signs in with its own argv", () => {
  const h = harness()
  h.utility.start("codex")
  assert.equal(h.spawned[0]!.file, "/stub/codex")
  assert.deepEqual(h.spawned[0]!.args, ["login"])
})

test("one live attempt per provider: a second start reuses the running pty", () => {
  const h = harness()
  const first = h.utility.start("claude")
  const second = h.utility.start("claude")
  assert.equal(second.attemptId, first.attemptId)
  assert.equal(h.spawned.length, 1, "a second Sign in click must not race a second OAuth flow")
})

test("a finished attempt is replaced rather than reused", () => {
  const h = harness()
  const first = h.utility.start("claude")
  h.spawned[0]!.exit() // the CLI finished (e.g. the flow failed)
  const second = h.utility.start("claude")
  assert.notEqual(second.attemptId, first.attemptId)
  assert.equal(h.spawned.length, 2)
})

test("attach gates on a live attempt; unknown ids never attach", () => {
  const h = harness()
  const { attemptId } = h.utility.start("claude")
  assert.ok(h.utility.attach(attemptId), "a live attempt attaches")
  assert.equal(h.utility.attach("login-0000000000000000"), null, "an unknown id never attaches")
  assert.equal(h.utility.attach("some-thread"), null, "a thread slug is not a login attempt")
})

// tmux used to multiplex viewers for free. This is the replacement, and it is the property that
// matters: two tabs on the sign-in modal watch ONE flow, and both see output printed before they
// opened — otherwise a tab opened after the OAuth URL scrolled past is useless.
test("every viewer shares one pty, and a late viewer replays what it missed", () => {
  const h = harness()
  const { attemptId } = h.utility.start("claude")
  const first = h.utility.attach(attemptId)!
  const seenByFirst: string[] = []
  first.onData((c) => seenByFirst.push(c))

  h.spawned[0]!.emit("Open https://oauth.example/xyz\n")

  const late = h.utility.attach(attemptId)!
  assert.match(late.replay(), /oauth\.example\/xyz/, "a tab opened later still sees the OAuth URL")

  h.spawned[0]!.emit("Paste the code: ")
  const seenByLate: string[] = []
  late.onData((c) => seenByLate.push(c))
  h.spawned[0]!.emit("…")
  assert.deepEqual(seenByFirst.at(-1), "…")
  assert.deepEqual(seenByLate, ["…"], "both viewers are fed by the same pty")
  assert.equal(h.spawned.length, 1)
})

test("a viewer's input and resize reach the shared pty; closing one viewer never kills it", () => {
  const h = harness()
  const { attemptId } = h.utility.start("claude")
  const a = h.utility.attach(attemptId)!
  const b = h.utility.attach(attemptId)!
  a.write("pasted-code\r")
  a.resize(100, 40)
  assert.deepEqual(h.spawned[0]!.written, ["pasted-code\r"])
  assert.deepEqual(h.spawned[0]!.resized, [[100, 40]])
  a.close()
  assert.equal(h.spawned[0]!.killed, false, "one tab closing must not abandon the other tab's flow")
  b.write("more")
  assert.deepEqual(h.spawned[0]!.written, ["pasted-code\r", "more"])
})

test("status: running until the CLI exits; an unknown id reads as exited", () => {
  const h = harness()
  const { attemptId } = h.utility.start("claude")
  assert.deepEqual(h.utility.status(attemptId), { state: "running", backend: "claude" })
  h.spawned[0]!.exit()
  assert.deepEqual(h.utility.status(attemptId), { state: "exited", backend: "claude" })
  assert.deepEqual(h.utility.status("login-ffffffffffffffff"), { state: "exited" })
})

test("cancel and stop kill the pty and drop the OAuth replay; teardown is idempotent", () => {
  const h = harness()
  const { attemptId } = h.utility.start("claude")
  const viewer = h.utility.attach(attemptId)!
  h.spawned[0]!.emit("https://oauth.example/secret")
  h.utility.cancel(attemptId)
  assert.equal(h.spawned[0]!.killed, true)
  assert.equal(viewer.replay(), "", "the OAuth bytes must not survive teardown")
  h.utility.cancel(attemptId) // second cancel is a no-op
  const again = h.utility.start("claude")
  h.utility.stop()
  assert.equal(h.spawned[1]!.killed, true)
  assert.equal(h.utility.attach(again.attemptId), null)
})

// The tmux implementation needed a boot-time sweep for `remain-on-exit` panes left in a detached
// server holding OAuth scrollback. A pty is a CHILD of this process, so that whole leak class is gone.
test("a viewer attached before exit is told when the CLI finishes", () => {
  const h = harness()
  const { attemptId } = h.utility.start("claude")
  const viewer = h.utility.attach(attemptId)!
  let exited = false
  viewer.onExit(() => { exited = true })
  h.spawned[0]!.exit()
  assert.equal(exited, true)
})

// A BARE name never reaches the pty. ConPTY's CreateProcessW finds `.exe` on PATH and nothing else an
// npm install writes, so the utility resolves the name itself and hands node-pty an absolute path —
// or, when nothing resolves, an attempt that explains itself instead of a dead pane (Windows audit
// 2026-09-11, finding 7). The resolvers are the real ones, pointed at a directory of this test's own.
test("a bare provider name is resolved to an absolute executable before it reaches the pty", { skip: process.platform === "win32" ? "posix resolution path" : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-login-bin-"))
  for (const name of ["claude", "codex"]) writeFileSync(join(dir, name), "#!/bin/sh\n", { mode: 0o755 })
  const h = harness({ claudeBin: "claude", codexBin: "codex", env: { PATH: dir } })
  const claude = h.utility.start("claude")
  const codex = h.utility.start("codex")
  assert.equal(h.spawned[0]!.file, join(dir, "claude"))
  assert.deepEqual(h.spawned[0]!.args, ["auth", "login"])
  assert.equal(h.spawned[1]!.file, join(dir, "codex"))
  assert.deepEqual(h.spawned[1]!.args, ["login"])
  assert.deepEqual(h.utility.status(claude.attemptId), { state: "running", backend: "claude" })
  assert.deepEqual(h.utility.status(codex.attemptId), { state: "running", backend: "codex" })
})

test("a name that resolves to nothing is the attempt's status and its replay, never a dead pane", () => {
  const empty = mkdtempSync(join(tmpdir(), "frizz-login-empty-"))
  const h = harness({ claudeBin: "claude", codexBin: "codex", env: { PATH: empty } })
  const { attemptId } = h.utility.start("codex")
  assert.match(attemptId, /^login-[0-9a-f]{16}$/, "still slug-shaped: the modal polls it like any other attempt")
  assert.equal(h.spawned.length, 0, "nothing reached the pty")
  const status = h.utility.status(attemptId)
  assert.equal(status.state, "exited")
  assert.equal(status.backend, "codex")
  assert.match(status.error ?? "", /Could not start the Codex sign-in: .*could not resolve 'codex'/)
  const viewer = h.utility.attach(attemptId)
  assert.ok(viewer, "a viewer attaches and reads the reason")
  assert.match(viewer!.replay(), /could not resolve 'codex'/)
  let exited = 0
  viewer!.onExit(() => exited++)
  assert.equal(exited, 1, "a late viewer of a finished attempt is told at once")
  // The next click starts over rather than attaching to the failure.
  const again = h.utility.start("codex")
  assert.notEqual(again.attemptId, attemptId)
})

test("a pty that refuses to spawn is reported the same way", () => {
  const h = harness({ spawnThrows: "File not found: /stub/claude" })
  const { attemptId } = h.utility.start("claude")
  assert.deepEqual(h.utility.status(attemptId), { state: "exited", backend: "claude", error: "Could not start the Claude sign-in: File not found: /stub/claude" })
  h.utility.cancel(attemptId)
  assert.deepEqual(h.utility.status(attemptId), { state: "exited" }, "teardown of a never-started attempt is clean")
})
