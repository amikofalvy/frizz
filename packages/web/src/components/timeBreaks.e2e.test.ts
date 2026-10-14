import assert from "node:assert/strict"
import test from "node:test"

// TIME BREAKS ON EVERY SURFACE THAT DRAWS A TRANSCRIPT (lib/timeBreaks). Skipped unless a Vite URL
// serving the fixtures is provided (same pattern as the other *.e2e.test.ts here): start `vite` in
// packages/web and set FRIZZ_TIME_BREAKS_E2E_URL to its origin.
//
// The reading replaced a hover timestamp that every message carried wherever one was drawn, and was
// built into the virtualized transcript alone — so from 2026-10-09 to 2026-10-13 a queue card had no
// reading of when anything on it was said, and nothing said so. These drive the SAME thread through the
// thread view and through its queue card and hold the two to one rule and one drawing.
//
// Measured in the browser because the card is where it can go wrong: its transcript is an imperative
// walk that hides rows, so a break can belong to a row that is never drawn.
const baseUrl = process.env.FRIZZ_TIME_BREAKS_E2E_URL

const ABOVE = 22
const BELOW = 6

type Reading = { kind: string; text: string; heads: string; spacerAbove: number; spacerBelow: number }

async function readings(variant: string, surface: "card" | "thread"): Promise<{ readings: Reading[]; errors: string[] }> {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 1 })
    const errors: string[] = []
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon|flushSync/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(new URL(`/time-breaks-fixture.html?variant=${variant}${surface === "card" ? "&surface=card" : ""}`, baseUrl).href, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-time-break]", { timeout: 15_000 })
    const found = await page.evaluate(() => {
      const isSpacer = (el: Element | null | undefined) => el instanceof HTMLElement && el.getAttribute("aria-hidden") === "true" && el.childElementCount === 0
      return [...document.querySelectorAll<HTMLElement>("[data-time-break]")]
        // The virtualizer's DOM order is not its visual order.
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
        .map((reading) => {
          const above = reading.previousElementSibling
          const below = reading.nextElementSibling
          return {
            kind: reading.dataset.timeBreak ?? "",
            text: (reading.textContent ?? "").replace(/\s+/g, " ").trim(),
            heads: (below?.nextElementSibling?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
            spacerAbove: isSpacer(above) ? above!.getBoundingClientRect().height : 0,
            spacerBelow: isSpacer(below) ? below!.getBoundingClientRect().height : 0,
          }
        })
    })
    return { readings: found, errors }
  } finally {
    await browser.close()
  }
}

const texts = (found: Reading[]) => found.map((r) => r.text.replace(/ /g, " "))

test("a parked turn: the wake that resumed it carries the break, on the thread view and on its queue card alike", { skip: !baseUrl }, async () => {
  const thread = await readings("park", "thread")
  const card = await readings("park", "card")
  assert.deepEqual(thread.errors, [], "the thread view logs no error")
  assert.deepEqual(card.errors, [], "the queue card logs no error")

  // One rule: the first dated row names the day, and the row after a 20m+ pause gives the time.
  assert.deepEqual(texts(thread.readings), ["Today 9:40 AM", "12:07 PM"])
  assert.deepEqual(texts(card.readings), texts(thread.readings), "the card reads as the thread view does")
  assert.deepEqual(card.readings.map((r) => r.kind), ["day", "time"])
  for (const surface of [thread, card]) {
    assert.match(surface.readings[0].heads, /^Kick off the release workflow/, "the day heads the human's ask")
    assert.match(surface.readings[1].heads, /^Background task «Watching the release run»/, "the pause's reading heads the wake that ended it")
  }

  // One drawing: the reading brings the same air on both, in place of the gap above the row it dates.
  for (const [name, surface] of [["thread view", thread], ["queue card", card]] as const) {
    const [first, second] = surface.readings
    assert.equal(first.spacerAbove, 0, `${name}: nothing above the reading at the top of what it draws`)
    assert.equal(first.spacerBelow, BELOW, `${name}: the first reading is tied to its message`)
    assert.equal(second.spacerAbove, ABOVE, `${name}: the reading stands off the row before it`)
    assert.equal(second.spacerBelow, BELOW, `${name}: …and is tied to the row it dates`)
  }
})

test("a break on a row the queue card hides heads the next row it draws", { skip: !baseUrl }, async () => {
  const thread = await readings("rounds", "thread")
  const card = await readings("rounds", "card")
  assert.deepEqual(card.errors, [], "the queue card logs no error")

  // Three runs. The thread view draws every row, so each wake carries its own reading.
  assert.deepEqual(texts(thread.readings), ["Today 9:40 AM", "10:30 AM", "12:07 PM"])
  // The card folds the middle run — its 10:30 wake with it — behind one divider. That break is not
  // drawn on a row that is not there, and it is not lost either: it waits for the next row the card
  // draws, which is the last run's wake, and that row is dated at its own instant.
  assert.deepEqual(texts(card.readings), ["Today 9:40 AM", "12:07 PM"])
  assert.match(card.readings[1].heads, /^Background task «Watching the release run»/)
  assert.equal(card.readings[1].spacerAbove, ABOVE, "under the fold's divider, with the break's own air")
})

test("a card whose window starts past the top of the transcript still names the day first", { skip: !baseUrl }, async () => {
  // The window is cut at the human's last ask, which here is the last message: yesterday's stretch and
  // this morning's are above it, behind "Load earlier messages". A bare `11:24 AM` would not say which
  // day, so the first dated row a surface draws is always a `day` reading.
  const card = await readings("split", "card")
  assert.deepEqual(card.errors, [], "the queue card logs no error")
  assert.deepEqual(texts(card.readings), ["Today 11:24 AM"])
  assert.equal(card.readings[0].kind, "day")
  assert.match(card.readings[0].heads, /^maybe its not worth encrypting/)
})
