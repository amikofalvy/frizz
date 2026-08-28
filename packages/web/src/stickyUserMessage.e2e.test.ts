import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for THE PINNED ASK'S COLLAPSE, which only a browser can settle: the cap is
// `calc(4lh + …)` (a resolved-font unit no unit test can evaluate), the fade is gated on a live
// `scrollHeight`/`clientHeight` read, and the defect this file exists for is a STATE TRANSITION —
// the first paint is correct and only the post-hover state is wrong, which is exactly what a
// one-shot screenshot pass cannot see.
//
// What went wrong: `measure()` on the mouse-leave RENDER reads a box still mid-transition, because
// max-height animates length→length and `clientHeight` is still the EXPANDED height in that task.
// For any ask shorter than the 85vh cap, expanded clientHeight IS scrollHeight, so the overflow test
// read false; `Message` is memoized, so nothing ever re-measured, and the pinned ask stayed
// hard-clipped mid-word with no fade for the rest of the session. Reproduced on the queue card at
// 1800x1000 with a 528px ask before `onCapTransitionEnd` began re-measuring.
//
// Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts
// here): start `vite` in packages/web and set FRIZZ_STICKY_USER_MESSAGE_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_STICKY_USER_MESSAGE_E2E_URL

// The queue card at this width gives the pinned bubble a 528px message — over the four-line cap and
// UNDER the 85vh expanded cap, which is the only band where the latch bit.
const WIDTH = 1800
const HEIGHT = 1000

test("the pinned ask collapses, expands on hover, and keeps its fade across hover cycles", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 })
    const errors: string[] = []
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))

    await page.goto(`${baseUrl}/sticky-user-message-fixture.html?surface=queue&size=medium`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-transcript-sticky]")

    // `position: sticky` pins between an element's own flow offset and the end of its containing
    // block, so the band only engages once the pane is scrolled past it — which is where a reader
    // sits, at the end of the transcript.
    await page.evaluate(() => {
      const band = document.querySelector("[data-transcript-sticky]")!
      let pane = band.parentElement
      while (pane && pane.scrollHeight <= pane.clientHeight + 4) pane = pane.parentElement
      if (pane) pane.scrollTop = pane.scrollHeight
    })
    await new Promise((r) => setTimeout(r, 200))

    const probe = () => page.evaluate(() => {
      const band = document.querySelector("[data-transcript-sticky]")!
      const capped = band.querySelector<HTMLElement>('[style*="max-height"]')
      return {
        clientH: capped?.clientHeight ?? null,
        scrollH: capped?.scrollHeight ?? null,
        overflowY: capped ? getComputedStyle(capped).overflowY : null,
        // The soft "there's more" cue. Present exactly while collapsed AND clipped.
        fades: band.querySelectorAll('[class*="bg-gradient-to-t"]').length,
        // The pin must be the HUMAN's turn, never a wake or a sub-agent's report.
        holdsWake: Boolean(band.querySelector("[data-frizz-wake]")),
      }
    })
    // React synthesizes enter/leave from delegated mouseover/mouseout, so a dispatched `mouseenter`
    // would not reach the handler.
    const pointer = (type: "mouseover" | "mouseout") => page.evaluate((t) => {
      const target = document.querySelector("[data-transcript-sticky] [data-frizz-msg]")!
      target.dispatchEvent(new MouseEvent(t, { bubbles: true, relatedTarget: document.body }))
    }, type)

    const collapsed = await probe()
    assert.equal(collapsed.holdsWake, false)
    assert.equal(collapsed.overflowY, "hidden", "a collapsed ask never scrolls — the wheel belongs to the transcript")
    assert.ok(collapsed.scrollH! > collapsed.clientH!, "this fixture must actually overflow, or the test proves nothing")
    assert.equal(collapsed.fades, 1, "a clipped ask wears the fade")
    const capHeight = collapsed.clientH!

    await pointer("mouseover")
    await new Promise((r) => setTimeout(r, 500))
    const expanded = await probe()
    assert.ok(expanded.clientH! > capHeight, "hovering opens the ask to its full height")
    assert.equal(expanded.fades, 0, "nothing is clipped once it is open, so nothing fades")

    await pointer("mouseout")
    await new Promise((r) => setTimeout(r, 700))
    const recollapsed = await probe()
    assert.equal(recollapsed.clientH, capHeight, "leaving returns it to the same cap")
    // THE REGRESSION: this read 0 before the transitionend re-measure, and stayed 0 forever after.
    assert.equal(recollapsed.fades, 1, "the fade must come back — a hard clip mid-word reads as broken")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a scheduler wake never takes the pinned band, on either surface", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    // Both surfaces pin from their own call site, and they carried this defect independently until
    // both were pointed at `lastAskIndex` — so both are asserted here.
    for (const surface of ["queue", "drawer"]) {
      await page.goto(`${baseUrl}/sticky-user-message-fixture.html?surface=${surface}&size=wake`, { waitUntil: "networkidle0" })
      await page.waitForSelector("[data-transcript-sticky]")
      await page.evaluate(() => {
        const band = document.querySelector("[data-transcript-sticky]")!
        let pane = band.parentElement
        while (pane && pane.scrollHeight <= pane.clientHeight + 4) pane = pane.parentElement
        if (pane) pane.scrollTop = pane.scrollHeight
      })
      await new Promise((r) => setTimeout(r, 200))
      const seen = await page.evaluate(() => {
        const band = document.querySelector("[data-transcript-sticky]")!
        const wake = document.querySelector("[data-frizz-wake]")
        return {
          bandHeight: Math.round(band.getBoundingClientRect().height),
          bandHoldsWake: Boolean(band.querySelector("[data-frizz-wake]")),
          wakeRendersInFlow: Boolean(wake) && !wake!.closest("[data-transcript-sticky]"),
        }
      })
      // Before the `wake` guard this band was the full height of the pane, holding the whole
      // delivered prompt over the transcript (maintainer 2026-08-21: "this dialog covers the entire
      // chat contents").
      assert.equal(seen.bandHoldsWake, false, `${surface}: the band holds the human's ask, not frizz's own turn`)
      assert.equal(seen.wakeRendersInFlow, true, `${surface}: the wake still renders, in flow, in order`)
      assert.ok(seen.bandHeight < 300, `${surface}: the pinned ask stays a band, not a wall (was ${seen.bandHeight}px)`)
    }
  } finally {
    await browser.close()
  }
})
