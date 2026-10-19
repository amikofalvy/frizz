import { test } from "node:test"
import assert from "node:assert/strict"
import { dayAndTime, messageStamp, restGapAt } from "./messageTime.ts"

// Local wall-clock instants, so the day boundary is the test machine's own midnight.
const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).toISOString()
const now = new Date(2026, 9, 9, 12, 0)

test("a reply 20m or more after the rest is dated; 19m is not", () => {
  assert.equal(restGapAt(at(9, 10, 0), at(9, 10, 19)), null)
  assert.equal(restGapAt(at(9, 10, 0), at(9, 10, 20)), at(9, 10, 20), "the reading is the reply's own instant")
  assert.equal(restGapAt(at(6, 16, 12), at(9, 8, 33)), at(9, 8, 33))
})

test("a reply on a new calendar day is dated even after a short wait", () => {
  assert.equal(restGapAt(at(8, 23, 58), at(9, 0, 3)), at(9, 0, 3))
})

test("an undated rest or reply keeps its plain hairline", () => {
  assert.equal(restGapAt(undefined, at(9, 10, 0)), null)
  assert.equal(restGapAt(at(9, 10, 0), undefined), null)
  assert.equal(restGapAt("nope", at(9, 10, 0)), null)
})

test("the hairline: Today and Yesterday by name, a weekday inside the week, then a date", () => {
  assert.deepEqual(dayAndTime(at(9, 8, 35), now, "en-US"), { day: "Today", time: "8:35 AM" })
  assert.deepEqual(dayAndTime(at(8, 15, 2), now, "en-US"), { day: "Yesterday", time: "3:02 PM" })
  assert.equal(dayAndTime(at(6, 9, 0), now, "en-US").day, "Tuesday")
  assert.equal(dayAndTime(at(1, 9, 0), now, "en-US").day, "Oct 1")
  assert.equal(dayAndTime(new Date(2025, 11, 30, 9, 0).toISOString(), now, "en-US").day, "Dec 30, 2025")
})

test("the hover: Today and Yesterday by name, then the full date, with the year once it is not this one", () => {
  assert.equal(messageStamp(at(9, 8, 33), now, "en-US"), "Today at 8:33 AM")
  assert.equal(messageStamp(at(8, 23, 5), now, "en-US"), "Yesterday at 11:05 PM")
  assert.equal(messageStamp(at(6, 16, 12), now, "en-US"), "Tuesday, October 6 at 4:12 PM")
  assert.equal(messageStamp(new Date(2025, 11, 30, 9, 0).toISOString(), now, "en-US"), "Tuesday, December 30, 2025 at 9:00 AM")
  assert.equal(messageStamp(undefined, now), null)
  assert.equal(messageStamp("not a date", now), null)
})
