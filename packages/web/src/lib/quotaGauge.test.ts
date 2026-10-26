import assert from "node:assert/strict"
import test from "node:test"
import type { QuotaWindow } from "@frizz/shared"
import { GAUGE, gaugeAngle, gaugeArc, gaugeNeedle, gaugeWindow, modelFamily, remainingPercent } from "./quotaGauge.ts"

const w = (key: string, usedPercent: number): QuotaWindow => ({ key, label: key, usedPercent })

test("a Claude alias names the family its weekly cap is keyed on; a Codex model has none", () => {
  assert.equal(modelFamily("claude", "opus"), "opus")
  assert.equal(modelFamily("claude", "sonnet"), "sonnet")
  assert.equal(modelFamily("claude", "opus[1m]"), "opus")
  assert.equal(modelFamily("codex", "gpt-5.5-codex"), undefined)
  assert.equal(modelFamily("claude", undefined), undefined)
})

test("the gauge reads the tightest window that binds the selected model", () => {
  const windows = [w("5h", 20), w("weekly", 30), w("weekly-opus", 94), w("weekly-sonnet", 50)]
  // Opus's own weekly cap is nearly spent: it binds Opus…
  assert.equal(gaugeWindow(windows, "opus")?.key, "weekly-opus")
  // …and is no concern of Sonnet's, whose own cap is the tightest that binds it.
  assert.equal(gaugeWindow(windows, "sonnet")?.key, "weekly-sonnet")
  // A model with no cap of its own is bound by the account-wide windows alone.
  assert.equal(gaugeWindow(windows, "haiku")?.key, "weekly")
  // The modern body slugs the model's display name, so a versioned key still belongs to its family.
  assert.equal(gaugeWindow([w("5h", 10), w("weekly-fable-5-1", 70)], "fable")?.key, "weekly-fable-5-1")
  assert.equal(gaugeWindow([w("5h", 10), w("weekly-fable-5-1", 70)], "opus")?.key, "5h")
})

test("an unfamiliar cap binds every model, and a tie keeps the earlier window", () => {
  assert.equal(gaugeWindow([w("5h", 10), w("monthly", 80)], undefined)?.key, "monthly")
  assert.equal(gaugeWindow([w("5h", 40), w("weekly", 40)], "opus")?.key, "5h")
})

test("only other models' caps reported: the gauge still reads something rather than nothing", () => {
  assert.equal(gaugeWindow([w("weekly-opus", 30), w("weekly-sonnet", 60)], "haiku")?.key, "weekly-sonnet")
  assert.equal(gaugeWindow([], "opus"), undefined)
})

test("remaining is whole and clamped", () => {
  assert.equal(remainingPercent(w("5h", 17.4)), 83)
  assert.equal(remainingPercent(w("5h", 104)), 0)
  assert.equal(remainingPercent(w("5h", -3)), 100)
})

test("the dial runs from E at the lower left, over the top, to F at the lower right", () => {
  assert.equal(gaugeAngle(0), GAUGE.start)
  assert.equal(gaugeAngle(50), 270, "half a tank points straight up")
  assert.equal(gaugeAngle(100), GAUGE.start + GAUGE.sweep)
  assert.equal(gaugeAngle(140), GAUGE.start + GAUGE.sweep, "clamped")

  const tip = (remaining: number) => gaugeNeedle(remaining).split("L")[1]!.split(" ").map(Number) as [number, number]
  const [ex, ey] = tip(0)
  const [hx, hy] = tip(50)
  const [fx, fy] = tip(100)
  assert.ok(ex < GAUGE.cx && ey > GAUGE.cy, "empty points lower left")
  assert.ok(Math.abs(hx - GAUGE.cx) < 0.01 && hy < GAUGE.cy, "half points up")
  assert.ok(fx > GAUGE.cx && fy > GAUGE.cy, "full points lower right")
})

test("the lit arc grows with the reading and is empty at zero", () => {
  assert.equal(gaugeArc(GAUGE.start, gaugeAngle(0)), "")
  // Under 180° of sweep is the short way round; a full tank's 240° needs the large-arc flag.
  assert.match(gaugeArc(GAUGE.start, gaugeAngle(50)), /A10 10 0 0 1 /)
  assert.match(gaugeArc(GAUGE.start, gaugeAngle(100)), /A10 10 0 1 1 /)
})
