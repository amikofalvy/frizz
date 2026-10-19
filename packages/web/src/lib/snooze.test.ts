import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import {
  DEFAULT_SNOOZE_PRESET,
  NOTHING_CAN_WAKE_IT,
  activitySnoozeRow,
  activitySnoozed,
  formatSnoozedUntil,
  formatSnoozeWake,
  formatAutoSnoozedUntil,
  formatUserSnooze,
  snoozePromptPreview,
  isSnoozePreset,
  localDateTimeInputValue,
  parseLocalSnooze,
  snoozePresetInstant,
  snoozePresetLabel,
} from "./snooze.ts"

test("snooze preset metadata has a stable one-day default and sentence-case labels", () => {
  assert.equal(DEFAULT_SNOOZE_PRESET, "1d")
  // The DURATION labels are the house duration grammar (`1d`, not "1 day") — the maintainer collapsed
  // every duration reading in the app onto one spelling on 2026-08-31.
  assert.equal(snoozePresetLabel(DEFAULT_SNOOZE_PRESET), "1d")
  // The calendar preset is not a duration, so it keeps its word — and its sentence case, because
  // "Tomorrow" was the only capitalized entry in the menu and it capitalized mid-phrase in the button.
  assert.equal(snoozePresetLabel("tomorrow"), "tomorrow")
  assert.equal(isSnoozePreset("1w"), true)
  assert.equal(isSnoozePreset("custom"), false)
})

test("snooze presets distinguish exact duration from tomorrow's local wall clock", () => {
  const now = new Date(2026, 11, 31, 23, 30, 0, 0)
  assert.equal(Date.parse(snoozePresetInstant("1h", now.getTime())) - now.getTime(), 60 * 60 * 1000)
  assert.equal(Date.parse(snoozePresetInstant("1d", now.getTime())) - now.getTime(), 24 * 60 * 60 * 1000)
  const tomorrow = new Date(snoozePresetInstant("tomorrow", now.getTime()))
  assert.deepEqual(
    [tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()],
    [2027, 0, 1, 9, 0],
  )
})

test("calendar tomorrow stays at 9 AM while exact-day snooze crosses a DST boundary", () => {
  const previousTz = process.env.TZ
  process.env.TZ = "America/Los_Angeles"
  try {
    const beforeSpringForward = new Date(2026, 2, 7, 12, 0, 0, 0)
    const exactDay = new Date(snoozePresetInstant("1d", beforeSpringForward.getTime()))
    const tomorrow = new Date(snoozePresetInstant("tomorrow", beforeSpringForward.getTime()))
    assert.equal(exactDay.getTime() - beforeSpringForward.getTime(), 86_400_000)
    assert.equal(exactDay.getHours(), 13, "24 elapsed hours is 13:00 after the missing spring hour")
    assert.equal(tomorrow.getHours(), 9, "calendar preset preserves the promised local wall clock")
    assert.deepEqual(parseLocalSnooze("2026-03-08T02:30", beforeSpringForward.getTime()), {
      ok: false,
      message: "That local time does not exist",
    })
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
})

test("custom local snooze round-trips wall-clock input and rejects normalized/past values", () => {
  const now = new Date(2026, 6, 13, 12, 0, 0, 0)
  assert.equal(localDateTimeInputValue(now), "2026-07-13T12:00")
  const parsed = parseLocalSnooze("2026-07-14T08:45", now.getTime())
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    const result = new Date(parsed.until)
    assert.deepEqual(
      [result.getFullYear(), result.getMonth(), result.getDate(), result.getHours(), result.getMinutes()],
      [2026, 6, 14, 8, 45],
    )
  }
  assert.deepEqual(parseLocalSnooze("2026-02-30T09:00", now.getTime()), { ok: false, message: "That local time does not exist" })
  assert.deepEqual(parseLocalSnooze("2026-07-13T11:59", now.getTime()), { ok: false, message: "Choose a time in the future" })
})

test("wake formatting uses the local calendar and locale-aware times", () => {
  const previousTz = process.env.TZ
  process.env.TZ = "America/Los_Angeles"
  try {
    const now = new Date(2026, 6, 13, 8, 0, 0, 0)
    const today = new Date(2026, 6, 13, 9, 0, 0, 0).toISOString()
    const tomorrow = new Date(2026, 6, 14, 9, 30, 0, 0).toISOString()
    const wednesday = new Date(2026, 6, 15, 21, 0, 0, 0).toISOString()
    const farDate = new Date(2026, 6, 21, 21, 0, 0, 0).toISOString()
    assert.equal(formatSnoozeWake(today, now.getTime()), "Today at 9:00 AM")
    assert.equal(formatSnoozeWake(tomorrow, now.getTime()), "Tomorrow at 9:30 AM")
    assert.equal(formatSnoozeWake(wednesday, now.getTime()), "Wednesday at 9:00 PM")
    assert.equal(formatSnoozeWake(farDate, now.getTime()), "Jul 21 at 9:00 PM")
    assert.equal(formatSnoozedUntil(wednesday, now.getTime()), "Snoozed until Wednesday at 9:00 PM")
    assert.equal(formatSnoozedUntil("not-a-date", now.getTime()), null)
    // A worker's timer park (`timers:`) is the SAME concept as a human snooze — an `auto` variant that resolves
    // itself by resuming the agent. Same wake phrase, "Auto-snoozed until" prefix.
    assert.equal(formatAutoSnoozedUntil(today, now.getTime()), "Auto-snoozed until today at 9:00 AM")
    assert.equal(formatAutoSnoozedUntil(wednesday, now.getTime()), "Auto-snoozed until Wednesday at 9:00 PM")
    assert.equal(formatAutoSnoozedUntil("not-a-date", now.getTime()), null)
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
})

test("a snooze carrying a prompt reads as the AUTO variant and names the follow-up it will send", () => {
  const previousTz = process.env.TZ
  process.env.TZ = "America/Los_Angeles"
  try {
    const now = new Date(2026, 6, 13, 8, 0, 0, 0)
    const wednesday = new Date(2026, 6, 15, 21, 0, 0, 0).toISOString()
    // Without a prompt it is still the reminder it always was — YOU act at the deadline.
    assert.equal(formatUserSnooze(wednesday, undefined, now.getTime()), "Snoozed until Wednesday at 9:00 PM")
    assert.equal(formatUserSnooze(wednesday, "   ", now.getTime()), "Snoozed until Wednesday at 9:00 PM")
    // With one, frizz resolves the park by resuming the agent — the same thing "Auto-snoozed" already
    // means for a worker's timer park, so it must not sprout a third vocabulary.
    assert.equal(
      formatUserSnooze(wednesday, "Check CI", now.getTime()),
      "Auto-snoozed until Wednesday at 9:00 PM — then: Check CI",
    )
    assert.equal(formatUserSnooze("not-a-date", "Check CI", now.getTime()), null)
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
})

test("a snooze prompt preview collapses to one line and truncates without spilling the tooltip", () => {
  assert.equal(snoozePromptPreview("  check\n  CI   now  "), "check CI now")
  assert.equal(snoozePromptPreview("abcdefghij", 5), "abcd\u2026")
  assert.equal(snoozePromptPreview("abcde", 5), "abcde", "exactly at the cap is not truncated")
})

// "UNTIL ACTIVITY" — the snooze menu's one row that is not a clock (2026-10-19). Offered only where the
// server says something can end it, greyed out with the reason where nothing can (maintainer: "gray it
// out"), and its right column names what it is waiting on where the clock rows name a time.
type RowInput = Parameters<typeof activitySnoozeRow>[0]
const resting = (over: Partial<RowInput> = {}): RowInput =>
  ({ runtime: "turn-idle", wakesOnItsOwn: true, subAgents: [], bgShells: [], watches: [], state: "open", ...over }) as RowInput
const watch = (over: Partial<ThreadView["watches"][number]>) =>
  ({ id: "w", kind: "github", target: "acme/app#1", state: "armed", ...over }) as ThreadView["watches"][number]

test("activitySnoozeRow: greyed out, with the reason, where nothing can end the park", () => {
  assert.deepEqual(
    { enabled: activitySnoozeRow(resting({ wakesOnItsOwn: undefined })).enabled, detail: activitySnoozeRow(resting({ wakesOnItsOwn: undefined })).detail },
    { enabled: false, detail: NOTHING_CAN_WAKE_IT },
  )
  assert.equal(activitySnoozeRow(resting({ runtime: "exited" })).enabled, false, "a dead worker wakes for nothing")
  // A turn in flight rests by itself; there is no rest to park yet.
  assert.deepEqual(
    { enabled: activitySnoozeRow(resting({ runtime: "running" })).enabled, detail: activitySnoozeRow(resting({ runtime: "running" })).detail },
    { enabled: false, detail: "Working now" },
  )
  assert.ok(activitySnoozeRow(resting({ wakesOnItsOwn: undefined })).title, "a disabled row says why on hover")
})

test("activitySnoozeRow: names what will end it", () => {
  const shell = { label: "nub run test", startedAt: "2026-10-19T10:00:00.000Z", state: "running" } as ThreadView["bgShells"][number]
  assert.equal(activitySnoozeRow(resting({ watches: [watch({})], bgShells: [shell] })).detail, "PR or shell")
  assert.equal(activitySnoozeRow(resting({ watches: [watch({ subject: "issue" })] })).detail, "issue")
  assert.equal(
    activitySnoozeRow(resting({
      watches: [watch({}), watch({ kind: "timer", target: "tmr_1" })],
      recurringPrompt: { prompt: "go", stopHook: false, heartbeat: true, postCompaction: false, armedAt: "2026-10-19T10:00:00.000Z" },
    })).detail,
    "PR, timer or goal",
  )
  // A watch that already fired is not a way back.
  assert.equal(activitySnoozeRow(resting({ watches: [watch({ state: "fired" })], bgShells: [shell] })).detail, "shell")
  assert.equal(activitySnoozeRow(resting({ watches: [watch({})] })).enabled, true)
})

test("activitySnoozed: armed, at rest, and still something to end it", () => {
  const t = { bgSnoozed: true, runtime: "turn-idle", wakesOnItsOwn: true } as const
  assert.equal(activitySnoozed(t), true)
  assert.equal(activitySnoozed({ ...t, wakesOnItsOwn: undefined }), false, "the server no longer honours it")
  assert.equal(activitySnoozed({ ...t, runtime: "running" }), false, "its own turn is the activity")
  assert.equal(activitySnoozed({ ...t, bgSnoozed: undefined }), false)
})
