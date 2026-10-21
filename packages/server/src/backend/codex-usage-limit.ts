import type { ProviderError, ProviderQuota } from "@frizz/shared"
import type { LimitFault } from "./types.ts"

export function codexLimitFault(error: ProviderError, at: string | undefined): LimitFault | undefined {
  if (error.retrying || !at || !Number.isFinite(Date.parse(at))) return undefined
  if (error.code !== "usage_limit_exceeded" && error.code !== "rate_limit_exceeded") return undefined
  return {
    window: "unknown", at,
    codex: /\bworkspace is out of credits\b/i.test(error.message) ? "credits" : "usage",
  }
}

// No inference from stale rollout telemetry, a pre-failure poll, or a clock alone. A provider can
// still reject a model-specific request despite aggregate headroom; the scheduler spends this key
// only once until the account changes, a turn succeeds, or a fresh blocked → available transition is
// observed. Percent/reset-time jitter must not turn a still-failing account into a retry loop.
export function codexLimitRecovery(
  fault: LimitFault,
  quota: ProviderQuota | undefined,
  nowMs: number,
): { key: string } | "blocked" | undefined {
  const live = quota?.codexRecovery
  const faultAt = Date.parse(fault.at)
  if (!fault.codex || !Number.isFinite(faultAt) || quota?.status !== "ok" || !live || !Number.isFinite(live.observedAt) ||
    live.observedAt <= faultAt || live.observedAt > nowMs || nowMs - live.observedAt > 60_000) return undefined
  if (live.blocked) return "blocked"
  const credits = live.creditsAvailable === true
  const headroom = quota.windows.length > 0 && quota.windows.every((w) =>
    Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 85)
  // Newer app-servers expose an account-validated permission for included usage. An explicit null
  // means unavailable, not permission to fall back to percentages; older versions omit the field.
  const included = live.ordinaryUsageAllowed === true ||
    (fault.codex !== "credits" && live.ordinaryUsageAllowed === undefined && headroom)
  if (!credits && !included) return "blocked"
  return { key: live.accountKey ?? "unidentified-codex-account" }
}
