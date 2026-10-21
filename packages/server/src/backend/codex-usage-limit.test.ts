import { test } from "node:test"
import assert from "node:assert/strict"
import type { ProviderQuota } from "@frizz/shared"
import { codexLimitFault, codexLimitRecovery } from "./codex-usage-limit.ts"

const at = "2026-01-15T12:00:00.000Z"
const now = Date.parse(at) + 180_000
const fault = codexLimitFault({ code: "usage_limit_exceeded", message: "Limit reached" }, at)!
const quota = (): ProviderQuota => ({
  status: "ok", windows: [
    { key: "5h", label: "5h", usedPercent: 10, resetsAt: now / 1000 + 3600 },
    { key: "weekly", label: "Weekly", usedPercent: 20, resetsAt: now / 1000 + 86400 },
  ],
  codexRecovery: { observedAt: now, accountKey: "one", creditsAvailable: false },
})

test("Codex limit classification requires a terminal typed error and a real timestamp", () => {
  assert.deepEqual(fault, { window: "unknown", at, codex: "usage" })
  assert.equal(codexLimitFault({ code: "rate_limit_exceeded", message: "Slow down" }, at)?.codex, "usage")
  assert.equal(codexLimitFault({ code: "usage_limit_exceeded", message: "Your workspace is out of credits. Ask your workspace owner to refill in order to continue." }, at)?.codex, "credits")
  for (const code of [undefined, "unauthorized", "session_budget_exceeded", "context_window_exceeded"]) {
    assert.equal(codexLimitFault({ code, message: "usage_limit_exceeded: workspace is out of credits" }, at), undefined)
  }
  assert.equal(codexLimitFault({ code: "usage_limit_exceeded", message: "Limit", retrying: true }, at), undefined)
  assert.equal(codexLimitFault({ code: "usage_limit_exceeded", message: "Limit" }, undefined), undefined)
  assert.equal(codexLimitFault({ code: "usage_limit_exceeded", message: "Limit" }, "invalid"), undefined)
})

test("Codex recovery trusts only fresh post-failure live evidence", () => {
  assert.equal(typeof codexLimitRecovery(fault, quota(), now), "object")
  for (const observedAt of [Date.parse(at), now + 1, now - 60_001, NaN]) {
    const q = quota()
    q.codexRecovery!.observedAt = observedAt
    assert.equal(codexLimitRecovery(fault, q, now), undefined)
  }
  const q = quota()
  delete q.codexRecovery
  assert.equal(codexLimitRecovery(fault, q, now), undefined, "rollout headroom is not recovery evidence")
  assert.equal(codexLimitRecovery(fault, { ...quota(), status: "unavailable" }, now), undefined)
  assert.equal(codexLimitRecovery(fault, undefined, now), undefined)
  const blocked = quota()
  blocked.codexRecovery!.creditsAvailable = true
  blocked.codexRecovery!.blocked = true
  assert.equal(codexLimitRecovery(fault, blocked, now), "blocked", "explicit workspace/spend-control denial wins")
})

test("Codex recovery requires headroom on every window or usable credits", () => {
  for (const usedPercent of [86, 100, -1, NaN]) {
    const q = quota()
    q.windows[1]!.usedPercent = usedPercent
    assert.equal(codexLimitRecovery(fault, q, now), "blocked")
  }
  const q = quota()
  q.windows = []
  assert.equal(codexLimitRecovery(fault, q, now), "blocked")
  q.codexRecovery!.creditsAvailable = true
  assert.equal(typeof codexLimitRecovery(fault, q, now), "object")
})

test("workspace credit exhaustion never recovers from subscription headroom alone", () => {
  const credits = { ...fault, codex: "credits" as const }
  const q = quota()
  assert.equal(codexLimitRecovery(credits, q, now), "blocked")
  delete q.codexRecovery!.creditsAvailable
  assert.equal(codexLimitRecovery(credits, q, now), "blocked")
  q.codexRecovery!.creditsAvailable = true
  assert.equal(typeof codexLimitRecovery(credits, q, now), "object")
})

test("an account-validated included-usage permission can recover credits without extra-usage spending", () => {
  const q = quota()
  q.codexRecovery!.ordinaryUsageAllowed = true
  assert.equal(typeof codexLimitRecovery({ ...fault, codex: "credits" }, q, now), "object")
  for (const ordinaryUsageAllowed of [false, null] as const) {
    q.codexRecovery!.ordinaryUsageAllowed = ordinaryUsageAllowed
    assert.equal(codexLimitRecovery(fault, q, now), "blocked", "no headroom inference when a newer backend cannot grant included usage")
  }
})

test("recovery keys distinguish accounts, never utilization or reset-time jitter", () => {
  const first = codexLimitRecovery(fault, quota(), now)
  const q = quota()
  q.windows.reverse()
  q.windows[0]!.usedPercent = 45
  assert.deepEqual(codexLimitRecovery(fault, q, now), first)
  q.codexRecovery!.accountKey = "two"
  assert.notDeepEqual(codexLimitRecovery(fault, q, now), first)
  q.codexRecovery!.accountKey = "one"
  q.windows[0]!.resetsAt! += 86400
  assert.deepEqual(codexLimitRecovery(fault, q, now), first)
})
