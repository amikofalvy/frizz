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

// BOTH renderers that can hold the pin, because they share the collapse hook and nothing else: a
// bubble (`size=medium`) and the composed multi-block answer (`size=answers`), which is a bordered
// card whose cap sits on its answer rows rather than on the card. Each carried its own copy of a
// fade defect the other did not. The fixture renders `data-font="sans"` — the app's own default,
// which the cap's `4lh` resolves against.
for (const size of ["medium", "answers"]) {
test(`the pinned ask (${size}) collapses, expands on hover, and keeps its fade across hover cycles`, {
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

    await page.goto(`${baseUrl}/sticky-user-message-fixture.html?surface=queue&size=${size}`, { waitUntil: "networkidle0" })
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
        // WHERE it ends, which is the whole point of it: the veil has to reach full opacity exactly
        // at the clip, or the cut row of text shows through it.
        fadeGap: (() => {
          const fade = band.querySelector('[class*="bg-gradient-to-t"]')
          if (!fade || !capped) return null
          return Math.round((fade.getBoundingClientRect().bottom - capped.getBoundingClientRect().bottom) * 100) / 100
        })(),
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
    // The answers card hung its fade on the CARD, so it ended 16px (the card's `p-4`) below the clip
    // and left the cut row under only 0.6 of the veil. It now lives inside the capped box, where
    // `bottom-0` IS the clip line.
    assert.equal(collapsed.fadeGap, 0, "the fade must end exactly where the content is cut")
    const capHeight = collapsed.clientH!

    await pointer("mouseover")
    await new Promise((r) => setTimeout(r, 500))
    const expanded = await probe()
    assert.ok(expanded.clientH! > capHeight, "hovering opens the ask to its full height")
    assert.equal(expanded.fades, 0, "nothing is clipped once it is open, so nothing fades")

    await pointer("mouseout")
    // MID-COLLAPSE, ~a third of the way through the 200ms tween: the box is already clipping hard and
    // has to be wearing the fade while it does. Measuring on the leave render alone reported "nothing
    // overflows" (the box is still expanded in that task) and blanked the fade for the whole
    // animation, so every mouse-leave flashed the bare hard cut this fade exists to hide.
    await new Promise((r) => setTimeout(r, 80))
    const collapsing = await probe()
    assert.ok(collapsing.clientH! < expanded.clientH!, "the collapse is actually in flight at this point")
    assert.ok(collapsing.scrollH! > collapsing.clientH!, "…and the box is clipping while it runs")
    assert.equal(collapsing.fades, 1, "the fade stays on THROUGH the collapse, not just after it")

    await new Promise((r) => setTimeout(r, 700))
    const recollapsed = await probe()
    assert.equal(recollapsed.clientH, capHeight, "leaving returns it to the same cap")
    // THE REGRESSION: this read 0 before the transitionend re-measure, and stayed 0 forever after.
    assert.equal(recollapsed.fades, 1, "the fade must come back — a hard clip mid-word reads as broken")

    assert.equal(recollapsed.fadeGap, 0, "and it comes back in the right place")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
}

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

test("a hovered pinned card never grows past the 85vh ceiling", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  try {
    const page = await browser.newPage()
    // A SHORT window is the only place this bites: the ceiling has to be smaller than the message for
    // it to bound anything at all. 400px puts 85vh at 340px against ~358px of answers.
    await page.setViewport({ width: 1200, height: 400, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/sticky-user-message-fixture.html?surface=queue&size=answers`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-answers-card]")

    const measure = () => page.evaluate(() => {
      const card = document.querySelector("[data-answers-card] > div")!
      const capped = document.querySelector<HTMLElement>('[data-answers-card] [style*="max-height"]')!
      return {
        cardH: Math.round(card.getBoundingClientRect().height),
        cappedH: Math.round(capped.getBoundingClientRect().height),
        contentH: capped.scrollHeight,
        ceiling: Math.round(window.innerHeight * 0.85),
      }
    })

    await page.evaluate(() => {
      document.querySelector("[data-answers-card]")!
        .dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }))
    })
    await new Promise((r) => setTimeout(r, 600))
    const open = await measure()

    assert.ok(open.contentH > open.ceiling, "this viewport must actually put the answers over the ceiling")
    // THE CEILING BOUNDS THE CARD, and the capped box is only the answer ROWS inside it. Applying 85vh
    // to the rows alone seated the hovered card at 85vh plus its chrome (head, `p-4`, border) — 402px
    // in a 400px window, i.e. taller than the viewport the ceiling exists to protect.
    assert.ok(open.cardH <= open.ceiling, `the whole card stays under 85vh (was ${open.cardH}px of ${open.ceiling}px)`)
    assert.ok(open.cardH > open.cappedH, "…and it is genuinely the card being bounded, chrome included")
  } finally {
    await browser.close()
  }
})
