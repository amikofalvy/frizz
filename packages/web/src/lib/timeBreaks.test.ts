import { test } from "node:test"
import assert from "node:assert/strict"
import { carryTimeBreak, timeBreakLabel, timeBreaks } from "./timeBreaks.ts"

// Local wall-clock instants, so the day boundary is the test machine's own midnight.
const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).toISOString()
type Row = { start?: string; end?: string }
const run = (rows: Row[]) => timeBreaks(rows, (r) => r.start, (r) => r.end ?? r.start)

test("the first dated row names its day, and a burst shares that one reading", () => {
  assert.deepEqual(run([{ start: at(9, 10, 51) }, { start: at(9, 10, 51) }, { start: at(9, 10, 52) }]), ["day", null, null])
})

test("a pause of 20m or more draws a time break; 19m does not", () => {
  assert.deepEqual(run([{ start: at(9, 10, 0) }, { start: at(9, 10, 19) }, { start: at(9, 10, 39) }]), ["day", null, "time"])
})

test("a new calendar day draws a day break even after a short pause", () => {
  assert.deepEqual(run([{ start: at(8, 23, 55) }, { start: at(9, 0, 5) }]), ["day", "day"])
})

test("the pause runs from the previous row's END, so a long tool run is not read as a pause", () => {
  // A run opened 10:00 and folded batches through 10:30; the prose after it at 10:31 is one minute on.
  assert.deepEqual(run([{ start: at(9, 10, 0), end: at(9, 10, 30) }, { start: at(9, 10, 31) }]), ["day", null])
})

test("an undated row draws nothing and does not reset the clock", () => {
  assert.deepEqual(run([{ start: at(9, 10, 0) }, {}, { start: at(9, 10, 5) }, { start: "nope" }, { start: at(9, 11, 0) }]), ["day", null, null, null, "time"])
  assert.deepEqual(run([{}, { start: at(9, 10, 0) }]), [null, "day"])
})

test("labels: Today and Yesterday by name, a weekday inside the week, then a date", () => {
  const now = new Date(2026, 9, 9, 12, 0)
  assert.deepEqual(timeBreakLabel(at(9, 10, 51), "day", now, "en-US"), { day: "Today", time: "10:51 AM" })
  assert.deepEqual(timeBreakLabel(at(8, 15, 2), "day", now, "en-US"), { day: "Yesterday", time: "3:02 PM" })
  assert.equal(timeBreakLabel(at(6, 9, 0), "day", now, "en-US").day, "Tuesday")
  assert.equal(timeBreakLabel(at(1, 9, 0), "day", now, "en-US").day, "Oct 1")
  assert.equal(timeBreakLabel(new Date(2025, 11, 30, 9, 0).toISOString(), "day", now, "en-US").day, "Dec 30, 2025")
  assert.deepEqual(timeBreakLabel(at(9, 11, 24), "time", now, "en-US"), { day: null, time: "11:24 AM" })
})

// The queue card hides rows, so a break can belong to one it never draws. It is carried to the next row
// the card does draw rather than dropped, and a carried DAY is still a day: the reader must not be left
// on yesterday because the row that crossed midnight was folded away.
test("a break on a hidden row is carried to the next drawn one, and a day outranks a time", () => {
  assert.equal(carryTimeBreak(null, null), null)
  assert.equal(carryTimeBreak(null, "time"), "time")
  assert.equal(carryTimeBreak("time", null), "time", "a hidden row's pause survives the rows after it")
  assert.equal(carryTimeBreak("time", "time"), "time", "two hidden pauses are one reading")
  assert.equal(carryTimeBreak("day", "time"), "day")
  assert.equal(carryTimeBreak("time", "day"), "day")
  assert.equal(carryTimeBreak("day", null), "day")
})
