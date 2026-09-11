import assert from "node:assert/strict"
import { test } from "node:test"
import {
  canRestart,
  canUpdateRestart,
  frizzBuildIdentity,
  getFrizzSupervisorStatus,
  IDLE_RESTART_HOLD,
  isDevFrizzBuild,
  nextRestartHold,
  requestFrizzRestart,
  requestFrizzUpdateRestart,
  RESTART_HOLD_DEADLINE_MS,
  restartFailureCopy,
  restartFailureOutcome,
  shouldReloadForNewBuild,
  type FrizzSupervisorStatus,
} from "./restart.ts"

const response = (body: string, status = 200, contentType = "application/json") => new Response(body, { status, headers: { "content-type": contentType } })

test("restart controls negotiate an explicit JSON protocol and reject SPA HTML fallbacks", async () => {
  const html = async () => response("<!doctype html><title>Frizz</title>", 200, "text/html")
  assert.equal(await getFrizzSupervisorStatus(html as typeof fetch), null)
  await assert.rejects(requestFrizzUpdateRestart(html as typeof fetch), /unavailable/)
})

test("restart controls reject stale protocol, missing routes, and network failures", async () => {
  const stale = async () => response(JSON.stringify({ protocol: 0, state: "ready" }))
  const missing = async () => response("missing", 404, "text/plain")
  const failed = async () => { throw new Error("network down") }
  assert.equal(await getFrizzSupervisorStatus(stale as typeof fetch), null)
  assert.equal(await getFrizzSupervisorStatus(missing as typeof fetch), null)
  assert.equal(await getFrizzSupervisorStatus(failed as typeof fetch), null)
  assert.equal(canRestart(null), false)
  assert.equal(canRestart({ protocol: 1, state: "ready" }), true)
  assert.equal(canUpdateRestart({ protocol: 1, state: "ready" }), false)
  assert.equal(canUpdateRestart({ protocol: 1, state: "ready", updateRestart: true }), true)
})

test("ordinary restart remains available without the update capability", async () => {
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined
  const supported = async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { input, init }
    return response(JSON.stringify({ protocol: 1, state: "ready" }), 202)
  }
  await requestFrizzRestart(supported as typeof fetch)
  assert.equal(request?.input, "/_frizz/control/restart")
  assert.equal(request?.init?.method, "POST")
})

test("update and restart requires an explicit supervisor capability and uses its one endpoint", async () => {
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined
  const supported = async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { input, init }
    return response(JSON.stringify({ protocol: 1, state: "ready", artifactDigest: "a".repeat(64), updateRestart: true }))
  }
  assert.equal((await getFrizzSupervisorStatus(supported as typeof fetch))?.artifactDigest, "a".repeat(64))
  assert.equal((await getFrizzSupervisorStatus(supported as typeof fetch))?.updateRestart, true)
  await requestFrizzUpdateRestart(supported as typeof fetch)
  assert.equal(request?.input, "/_frizz/control/update-restart")
  assert.equal(request?.init?.method, "POST")

  const failure = async () => response(JSON.stringify({ protocol: 1, state: "failed", message: "candidate rejected" }), 503)
  await assert.rejects(requestFrizzUpdateRestart(failure as typeof fetch), /candidate rejected/)
})

test("an accepted update transition is not misreported as a restart failure", async () => {
  const accepted = async () => response(JSON.stringify({ protocol: 1, state: "restarting" }), 202)
  assert.equal((await requestFrizzUpdateRestart(accepted as typeof fetch)).state, "restarting")
})

// The two conditions behind the Update-vs-Restart label. Conflating them shipped: production reported
// only the CAPABILITY, so a fully current Frizz still offered "Update Frizz" and a click reinstalled its
// own version and restarted the app for nothing.
test("the update label needs the verb wired AND a newer artifact to actually exist", () => {
  const status = (over: Record<string, unknown>) =>
    ({ protocol: 1, state: "ready", ...over }) as Parameters<typeof canUpdateRestart>[0]

  assert.equal(canUpdateRestart(status({ updateRestart: true, updateAvailable: true })), true)
  assert.equal(
    canUpdateRestart(status({ updateRestart: true, updateAvailable: false })), false,
    "already current ⇒ offer a plain Restart, never an Update that installs nothing",
  )
  assert.equal(
    canUpdateRestart(status({ updateRestart: true })), true,
    "absent ⇒ assume available, so frizz-dev (which can always rebuild from source) is unchanged",
  )
  assert.equal(
    canUpdateRestart(status({ updateRestart: false, updateAvailable: true })), false,
    "availability can never conjure the verb on a supervisor that cannot promote an artifact",
  )
})

// Why a field at all: the client cannot see this. `import.meta.env.DEV` is a Vite COMPILE-TIME
// constant, false in the production bundle every frizz-dev artifact serves — so the dev-only
// Restart-worker verb was eliminated from the build it exists for. The launcher answers instead.
test("a development build is only ever what the supervisor explicitly reports", async () => {
  const status = (over: Record<string, unknown>) =>
    ({ protocol: 1, state: "ready", ...over }) as Parameters<typeof isDevFrizzBuild>[0]

  assert.equal(isDevFrizzBuild(status({ dev: true })), true, "frizz-dev / pnpm dev")
  assert.equal(
    isDevFrizzBuild(status({})), false,
    "a published Frizz, and any supervisor predating the field, must never show a dev-only verb",
  )
  assert.equal(
    isDevFrizzBuild(status({ updateRestart: true })), false,
    "Update & Restart is wired in PRODUCTION too — it can never stand in for a dev signal",
  )
  assert.equal(isDevFrizzBuild(null), false, "an unreachable supervisor is not a licence to show one")

  // And it has to survive the wire, not just the predicate.
  const dev = async () => response(JSON.stringify({ protocol: 1, state: "ready", dev: true }))
  assert.equal(isDevFrizzBuild(await getFrizzSupervisorStatus(dev as typeof fetch)), true)
})

// ── Finding 1 (audit 2026-09-11): the restart hold has a deadline ────────────────────────────────────
// After a detached handoff every poll comes back null. App used to ignore those, so a successor that
// never came up left the blocking overlay on screen forever with nothing to say. The reducer below is
// what the App effect steps once per poll; this pins the clock as arithmetic.
test("the restart hold stalls after three minutes of unanswered polls, and only then", () => {
  const t0 = 1_000_000
  let hold = IDLE_RESTART_HOLD
  // The supervisor is still answering "restarting" (a durable build in progress): no silence accrues.
  hold = nextRestartHold(hold, { restarting: true, answered: true, at: t0 })
  assert.deepEqual(hold, IDLE_RESTART_HOLD)
  // The old process exits; the first null starts the clock.
  hold = nextRestartHold(hold, { restarting: true, answered: false, at: t0 + 1_000 })
  assert.equal(hold.silentSince, t0 + 1_000)
  assert.equal(hold.stalled, false)
  for (const at of [t0 + 30_000, t0 + 120_000, t0 + 1_000 + RESTART_HOLD_DEADLINE_MS - 1]) {
    hold = nextRestartHold(hold, { restarting: true, answered: false, at })
    assert.equal(hold.stalled, false, `still inside the deadline at +${at - t0}ms`)
    assert.equal(hold.silentSince, t0 + 1_000, "the clock is measured from the FIRST silent poll, not the latest")
  }
  hold = nextRestartHold(hold, { restarting: true, answered: false, at: t0 + 1_000 + RESTART_HOLD_DEADLINE_MS })
  assert.equal(hold.stalled, true)
  assert.equal(hold.silentForMs, RESTART_HOLD_DEADLINE_MS, "the overlay reads its `3m` off this, never off a clock in render")
  assert.equal(RESTART_HOLD_DEADLINE_MS, 3 * 60_000)
})

test("any protocol answer resets the hold's clock, and nothing accrues without an overlay to hold", () => {
  const stalled = nextRestartHold({ silentSince: 0, silentForMs: 0, stalled: false }, { restarting: true, answered: false, at: RESTART_HOLD_DEADLINE_MS })
  assert.equal(stalled.stalled, true)
  // A durable supervisor that comes back mid-build and says so: a slow build is not a dead board.
  assert.deepEqual(nextRestartHold(stalled, { restarting: true, answered: true, at: RESTART_HOLD_DEADLINE_MS + 500 }), IDLE_RESTART_HOLD)
  // The board is ready again (whatever the poll said): the hold is over.
  assert.deepEqual(nextRestartHold(stalled, { restarting: false, answered: true, at: RESTART_HOLD_DEADLINE_MS + 500 }), IDLE_RESTART_HOLD)
  // Null polls against a board that is NOT restarting (server down at rest) never raise the notice.
  assert.deepEqual(nextRestartHold(IDLE_RESTART_HOLD, { restarting: false, answered: false, at: 5 }), IDLE_RESTART_HOLD)
  // And after a reset, silence starts a fresh clock rather than resuming the old one.
  const again = nextRestartHold(IDLE_RESTART_HOLD, { restarting: true, answered: false, at: 9_000 })
  assert.equal(again.silentSince, 9_000)
  assert.equal(again.stalled, false)
})

// ── Finding 8: every tab reloads onto a new build, not just the one that clicked ─────────────────────
test("a ready answer from a different build than this page first saw means reload", () => {
  const ready = (over: Record<string, unknown>) => ({ protocol: 1, state: "ready", ...over }) as FrizzSupervisorStatus
  // frizz-dev's durable owner names an artifact digest; the registry launcher names a version.
  assert.equal(frizzBuildIdentity(ready({ artifactDigest: "a".repeat(64) })), "a".repeat(64))
  assert.equal(frizzBuildIdentity(ready({ version: "0.4.2" })), "0.4.2")
  assert.equal(frizzBuildIdentity(ready({ artifactDigest: "d", version: "0.4.2" })), "d", "the digest is the finer identity when both are sent")
  assert.equal(frizzBuildIdentity(ready({})), null)
  assert.equal(frizzBuildIdentity(null), null)

  assert.equal(shouldReloadForNewBuild("0.4.2", ready({ version: "0.5.0" })), true, "the other tabs' case: same server slot, new version")
  assert.equal(shouldReloadForNewBuild("0.4.2", ready({ version: "0.4.2" })), false, "an ordinary Restart keeps the build")
  assert.equal(shouldReloadForNewBuild("a".repeat(64), ready({ artifactDigest: "b".repeat(64) })), true)
  assert.equal(shouldReloadForNewBuild("0.4.2", { protocol: 1, state: "restarting", version: "0.5.0" }), false, "nothing to load until the successor is READY")
  assert.equal(shouldReloadForNewBuild("0.4.2", { protocol: 1, state: "failed", version: "0.5.0" }), false, "a successor whose board failed serves no bundle either")
  assert.equal(shouldReloadForNewBuild("0.4.2", ready({})), false, "a supervisor that stops naming builds cannot be told apart — never loop")
  assert.equal(shouldReloadForNewBuild(null, ready({ version: "0.5.0" })), false, "no first identity, no comparison")
  assert.equal(shouldReloadForNewBuild("0.4.2", null), false)
})

// ── Finding 11: "kept running the previous version" is only true when it did ────────────────────────
test("a failed answer naming the version we clicked on means the old launcher gave up; a newer one means the successor failed", () => {
  assert.deepEqual(restartFailureOutcome("0.4.2", { version: "0.4.2" }), { kind: "previous-kept" })
  assert.deepEqual(restartFailureOutcome(undefined, {}), { kind: "previous-kept" }, "frizz-dev names no version and rolls back in place")
  assert.deepEqual(restartFailureOutcome("0.4.2", { version: "0.5.0" }), { kind: "successor-failed", version: "0.5.0" })
  assert.deepEqual(restartFailureOutcome("0.4.2", {}), { kind: "successor-failed", version: undefined }, "a different answerer that names nothing is still not the one we clicked on")

  const kept = restartFailureCopy({ kind: "previous-kept" })
  assert.equal(kept.detail, "Frizz kept running the previous version, and your threads are unaffected.")
  assert.equal(kept.summary, "Frizz kept running the previous version")
  const successor = restartFailureCopy({ kind: "successor-failed", version: "0.5.0" })
  assert.equal(successor.summary, "Frizz 0.5.0 failed to start")
  assert.match(successor.detail, /^Frizz 0\.5\.0 came up but could not start its board, and the previous version is gone\./)
  assert.match(successor.detail, /npx frizz/)
  assert.doesNotMatch(successor.detail, /kept running/)
  assert.match(restartFailureCopy({ kind: "successor-failed" }).summary, /^The new version of Frizz failed to start$/)
})
