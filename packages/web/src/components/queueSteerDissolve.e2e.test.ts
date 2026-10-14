import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the invariant CardSlot states and nothing used to enforce: a dismissed queue card
// "fades out AT FULL HEIGHT ... There is no height-collapse phase". Skipped unless a Vite URL serving the
// fixtures is provided (same pattern as the other *.e2e.test.ts here): start `vite` in packages/web and
// set FRIZZ_QUEUE_STEER_DISSOLVE_E2E_URL to its origin.
//
// THE BUG THIS PINS (maintainer 2026-09-04: "there's a lot of jitter, up-and-down jitter, before it
// settles"). Steering the agent dismisses the card AND appends the optimistic user bubble to the same
// transcript cache the card renders from — and the card's default window reaches back to the human's most
// recent turn, which that bubble now IS. Measured on a real steer before the fix: the card grew 58px at
// 27ms (the bubble), then dropped 276px at 77ms (everything above the bubble collapsed behind "Load
// earlier messages"), then unmounted at 342ms. Every card below it was shoved down, then up, then up
// again, inside one 200ms fade.
//
// The assertion is the reader's own invariant, not an internal one: from the keystroke to the unmount the
// card's layout box does not change and the card beneath it does not move.
const baseUrl = process.env.FRIZZ_QUEUE_STEER_DISSOLVE_E2E_URL

const STEERED = "csv-export"
const BELOW = "flaky-e2e"

test("steering a queue card dissolves it at a frozen height — the cards below it never move", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/queue-dissolve-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`[data-queue-card-root="${STEERED}"]`)
    await page.waitForSelector(`[data-queue-card-root="${BELOW}"]`)

    const composer = `[data-queue-card="${STEERED}"] textarea[placeholder*="reply" i]`
    await page.waitForSelector(composer)
    await page.click(composer)
    // Long enough to WRAP, on purpose: the composer auto-grows with the text and collapses back the
    // instant the send clears it, which is the height change the exit pin exists for. A one-line steer
    // exercises only the transcript half of the fix.
    await page.type(composer, "Thanks — now do a second pass over the narrow viewport case: the CTA column collapses under 360px and the badge wraps onto a second line.")
    await new Promise((r) => setTimeout(r, 200))

    // Sample on every animation frame, in-page: a round trip per sample would miss the 50ms window the
    // two height changes lived in.
    await page.evaluate((steered: string, below: string) => {
      const w = window as unknown as { __steerFrames: { t: number; h: number | null; op: number | null; belowTop: number | null }[] }
      w.__steerFrames = []
      const t0 = performance.now()
      const tick = () => {
        const card = document.querySelector<HTMLElement>(`[data-queue-card-root="${steered}"]`)
        const slot = document.querySelector<HTMLElement>(`[data-queue-card="${steered}"]`)
        const next = document.querySelector<HTMLElement>(`[data-queue-card-root="${below}"]`)
        w.__steerFrames.push({
          t: +(performance.now() - t0).toFixed(1),
          // offsetHeight, not the painted rect: the leaving card wears scale(0.94), which shrinks what is
          // drawn without moving anything. The LAYOUT box is what shoves the cards beneath it.
          h: card ? card.offsetHeight : null,
          op: slot ? +Number(getComputedStyle(slot).opacity).toFixed(3) : null,
          belowTop: next ? +next.getBoundingClientRect().top.toFixed(1) : null,
        })
        if (performance.now() - t0 < 900) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, STEERED, BELOW)

    const before = await page.evaluate((steered: string, below: string) => ({
      h: document.querySelector<HTMLElement>(`[data-queue-card-root="${steered}"]`)!.offsetHeight,
      belowTop: +document.querySelector<HTMLElement>(`[data-queue-card-root="${below}"]`)!.getBoundingClientRect().top.toFixed(1),
    }), STEERED, BELOW)

    await page.keyboard.press("Enter")
    await new Promise((r) => setTimeout(r, 1100))
    const frames = await page.evaluate(() => (window as unknown as { __steerFrames: { t: number; h: number | null; op: number | null; belowTop: number | null }[] }).__steerFrames)

    const mounted = frames.filter((f) => f.h !== null)
    assert.ok(mounted.length > 4, `expected the card to stay mounted for several frames, got ${mounted.length}`)
    assert.ok(frames.some((f) => f.h === null), "the card must unmount within the sampled window")

    const heights = [...new Set(mounted.map((f) => f.h))]
    assert.deepEqual(heights, [before.h], `the card's height changed while it dissolved: ${JSON.stringify(mounted.filter((f) => f.h !== before.h).slice(0, 6))}`)

    // The card below is the reader's own witness: it must sit exactly where it was until the steered card
    // unmounts, at which point the deliberate one-shot landing moves it once.
    const untilUnmount = frames.slice(0, frames.findIndex((f) => f.h === null))
    const moved = untilUnmount.filter((f) => f.belowTop !== null && Math.abs(f.belowTop - before.belowTop) > 0.5)
    assert.deepEqual(moved, [], `a card below the dissolving one moved before the unmount: ${JSON.stringify(moved.slice(0, 6))}`)

    // …and the card is still THERE until it unmounts. A slot that has faded to nothing but still holds the
    // card's full height is an empty hole the reader watches before anything moves: 72-128ms of it on
    // real workers, while the exit waited out 120ms of slack past the fade (2026-10-13). One frame is the
    // fade's own last one; the unmount must follow it. Measured in TIME, not samples: a headless page runs
    // animation frames faster than a 60Hz display, so one display frame can be two samples here.
    const firstBlank = mounted.find((f) => f.op !== null && f.op < 0.05)
    const unmountAt = frames.find((f) => f.h === null)!.t
    const blankMs = firstBlank ? unmountAt - firstBlank.t : 0
    assert.ok(blankMs <= 25, `the dissolved card held an empty slot for ${blankMs.toFixed(0)}ms before unmounting: ${JSON.stringify(mounted.filter((f) => f.op !== null && f.op < 0.05).slice(0, 8))}`)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// THE SAME DEFECT THROUGH A SEND THAT DOES NOT DISMISS. The freeze above hangs on `leaving`, which only
// resolve() sets — but Retry and Restart worker, both on the queue card's OWN header, send through the
// same sendEagerFollowUp without resolving anything (so does the rail's hover Retry). A stalled or
// limit-killed thread is a hard queue member, which is precisely when those buttons show, so the card
// takes the optimistic bubble and then the worker's echo while sitting still in the queue — and with
// nothing dismissing it, the jitter has seconds to play instead of 200ms.
//
// Driven through sendEagerFollowUp itself rather than a button, so the assertion stays about the card and
// not about which header happens to carry the verb today.
test("a queue card holds still through a send that does not dismiss it — Retry, Restart worker, the rail", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/queue-dissolve-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`[data-queue-card-root="${STEERED}"]`)
    await page.waitForSelector(`[data-queue-card-root="${BELOW}"]`)
    await new Promise((r) => setTimeout(r, 300))

    // DOCUMENT geometry (offsetTop), not viewport geometry: the assertion is about the layout of the
    // queue, and offsetTop reads it whatever the page's scroll position is doing. (Until 2026-10-12 a
    // send from anywhere but the card's own composer also smooth-scrolled the whole page toward its
    // bottom for ~800ms, which is why this reading was chosen; appendQueuedMessage no longer does.)
    const before = await page.evaluate((steered: string, below: string) => ({
      h: document.querySelector<HTMLElement>(`[data-queue-card-root="${steered}"]`)!.offsetHeight,
      belowTop: document.querySelector<HTMLElement>(`[data-queue-card-root="${below}"]`)!.offsetTop,
    }), STEERED, BELOW)

    await page.evaluate((steered: string, below: string) => {
      const w = window as unknown as {
        __steerFrames: { t: number; h: number | null; belowTop: number | null }[]
        __steerFromElsewhere: (slug: string, text: string) => void
        __pushLandedTurn: (slug: string, text: string) => void
      }
      w.__steerFrames = []
      const t0 = performance.now()
      const tick = () => {
        const card = document.querySelector<HTMLElement>(`[data-queue-card-root="${steered}"]`)
        const next = document.querySelector<HTMLElement>(`[data-queue-card-root="${below}"]`)
        w.__steerFrames.push({
          t: +(performance.now() - t0).toFixed(1),
          h: card ? card.offsetHeight : null,
          belowTop: next ? next.offsetTop : null,
        })
        if (performance.now() - t0 < 900) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      // Both writes, in the order and at roughly the spacing they were measured at on a real worker: the
      // optimistic bubble on commit, the worker's echo of it ~150ms later.
      w.__steerFromElsewhere(steered, "Answering from the thread drawer instead of the card, which is the door the leaving gate never covered.")
      setTimeout(() => w.__pushLandedTurn(steered, "Answering from the thread drawer instead of the card, which is the door the leaving gate never covered."), 150)
    }, STEERED, BELOW)

    await new Promise((r) => setTimeout(r, 1100))
    const frames = await page.evaluate(() => (window as unknown as { __steerFrames: { t: number; h: number | null; belowTop: number | null }[] }).__steerFrames)

    // The board LAGS on this path by construction, so unlike the dismissal above the card must still be
    // there at the end — a card that vanished would make every height assertion below vacuous.
    assert.ok(frames.length > 20, `expected a full sampling window, got ${frames.length} frames`)
    assert.equal(frames.at(-1)?.h !== null, true, "the card must still be mounted: the board has not caught up yet")

    const heights = [...new Set(frames.map((f) => f.h))]
    assert.deepEqual(heights, [before.h], `the card changed height on a steer it did not send: ${JSON.stringify(frames.filter((f) => f.h !== before.h).slice(0, 6))}`)

    const moved = frames.filter((f) => f.belowTop !== null && Math.abs(f.belowTop - before.belowTop) > 0.5)
    assert.deepEqual(moved, [], `a card below the steered one was relaid out: ${JSON.stringify(moved.slice(0, 6))}`)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// A CARD COMING BACK TO THE QUEUE MOUNTS ONCE, WITH ITS REPLY. The steered card above took its transcript's
// only observer with it, so nothing was pushed while its turn ran; the turn's end reaches the queue as a
// board row at rest whose newest record is the reply, and the reply itself only through a fetch. The card
// used to mount on the board row over its pre-turn cache — the human's message with nothing under it —
// and grow when the fetch landed (lib/queueReturn). The fixture's read takes 120ms, longer than the real
// one, so a regression shows as several frames rather than one.
test("a card coming back to the queue mounts once, with its reply — never over its pre-turn cache", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  const STEER = "Summarise the export path in one sentence."
  const REPLY = "The export streams rows from a server cursor straight into the response, so memory stays flat."
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/queue-dissolve-fixture.html`, { waitUntil: "networkidle0" })
    const composer = `[data-queue-card="${STEERED}"] textarea[placeholder*="reply" i]`
    await page.waitForSelector(composer)
    await page.click(composer)
    await page.type(composer, STEER)
    await page.keyboard.press("Enter")
    await page.waitForFunction((steered: string) => !document.querySelector(`[data-queue-card-root="${steered}"]`), { timeout: 5_000 }, STEERED)
    await new Promise((r) => setTimeout(r, 400))

    await page.evaluate((steered: string, steer: string, reply: string) => {
      const w = window as unknown as {
        __returnFrames: { t: number; present: boolean; reply: boolean; h: number | null }[]
        __endTurn: (slug: string, steer: string, reply: string, readMs: number) => void
      }
      w.__returnFrames = []
      const t0 = performance.now()
      const tick = () => {
        const card = document.querySelector<HTMLElement>(`[data-queue-card-root="${steered}"]`)
        w.__returnFrames.push({ t: +(performance.now() - t0).toFixed(1), present: !!card, reply: !!card?.innerText.includes(reply.slice(0, 40)), h: card ? card.offsetHeight : null })
        if (performance.now() - t0 < 1500) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      w.__endTurn(steered, steer, reply, 120)
    }, STEERED, STEER, REPLY)
    await new Promise((r) => setTimeout(r, 1700))
    const frames = await page.evaluate(() => (window as unknown as { __returnFrames: { t: number; present: boolean; reply: boolean; h: number | null }[] }).__returnFrames)

    const shown = frames.filter((f) => f.present)
    assert.ok(shown.length > 5, `the card must come back to the queue: ${shown.length} frames with it mounted`)
    const stale = shown.filter((f) => !f.reply)
    assert.deepEqual(stale, [], `the returning card painted without its reply: ${JSON.stringify(stale.slice(0, 6))}`)
    assert.equal(new Set(shown.map((f) => f.h)).size, 1, `the returning card changed height after it mounted: ${JSON.stringify([...new Set(shown.map((f) => f.h))])}`)
    // Held only for the read, nowhere near the cap.
    assert.ok(shown[0].t < 600, `the card came back late: first frame at ${shown[0].t}ms`)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// A TURN THAT ENDS INSIDE THE CARD'S OWN FADE. The dismissal's exit takes ~300ms; a turn can be over
// sooner than that (a worker that answers from cache, a refusal, a hook that ends the turn at once), and
// then the board puts the thread back in the queue while its card is still fading out. The exit had no
// case for that. Recorded against the scripted Claude (replythink=0 disklag=25, 3 of 3, 2026-10-13): the
// card was cut mid-fade at +107-144ms, an invisible full-height slot stood in its place from +141-184ms
// to +348-365ms, and then the thread had NO card at all until the dismissal's 8s guard gave it back.
// Now the fade finishes on the snapshot it started on, and the commit that ends it mounts the card
// again, at the queue's end, with its reply.
//
// Twice, because the board reports such a turn in two ways. Usually it drops the thread and puts it back
// (`boardDrops`). But a tailer tick that sees the message and the reply together reports one row, still
// queued, at a newer rest: nothing departs, and the card being dismissed was handed that rest mid-fade —
// moved to the queue's end as an invisible slot, then hidden with its unread reply until the guard.
for (const boardDrops of [true, false]) test(`a turn that ends inside the card's own fade (${boardDrops ? "the board drops the thread and puts it back" : "the board only moves it to a newer rest"}): the fade finishes, and the card comes back once with its reply`, {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  const STEER = "Is the export path streaming yet?"
  const REPLY = "Yes: rows go from a server cursor straight into the response, so memory stays flat."
  type Frame = { t: number; present: boolean; leaving: boolean; op: number | null; reply: boolean; h: number | null }
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/queue-dissolve-fixture.html`, { waitUntil: "networkidle0" })
    const composer = `[data-queue-card="${STEERED}"] textarea[placeholder*="reply" i]`
    await page.waitForSelector(composer)
    await page.click(composer)
    await page.type(composer, STEER)
    await new Promise((r) => setTimeout(r, 200))

    await page.evaluate((steered: string, reply: string) => {
      const w = window as unknown as { __fastFrames: unknown[] }
      w.__fastFrames = []
      const t0 = performance.now()
      const tick = () => {
        const slot = document.querySelector<HTMLElement>(`[data-queue-card="${steered}"]`)
        const card = document.querySelector<HTMLElement>(`[data-queue-card-root="${steered}"]`)
        w.__fastFrames.push({
          t: +(performance.now() - t0).toFixed(1),
          present: !!card,
          leaving: slot?.dataset.queueLeaving === "true",
          op: slot ? Math.round(Number(getComputedStyle(slot).opacity) * 100) / 100 : null,
          reply: !!card?.innerText.includes(reply.slice(0, 40)),
          h: card ? card.offsetHeight : null,
        })
        if (performance.now() - t0 < 2500) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, STEERED, REPLY)
    if (!boardDrops) await page.evaluate((steered: string) => (window as unknown as { __lagBoard: (slug: string) => void }).__lagBoard(steered), STEERED)
    await page.keyboard.press("Enter")
    // The turn is over 90ms after the send: the board has the thread back at rest before the fade is done.
    await new Promise((r) => setTimeout(r, 90))
    await page.evaluate((steered: string, steer: string, reply: string) => {
      ;(window as unknown as { __endTurn: (slug: string, steer: string, reply: string, readMs: number) => void }).__endTurn(steered, steer, reply, 20)
    }, STEERED, STEER, REPLY)
    await new Promise((r) => setTimeout(r, 2600))
    const frames = (await page.evaluate(() => (window as unknown as { __fastFrames: unknown[] }).__fastFrames)) as Frame[]

    assert.ok(frames.length > 40, `expected a full sampling window, got ${frames.length} frames`)
    const fading = frames.filter((f) => f.present && f.leaving)
    assert.ok(fading.length > 5, `the card must fade out: ${fading.length} leaving frames`)
    const ended = frames.findIndex((f) => f.t >= 90)
    assert.ok(frames.slice(ended).some((f) => f.present && f.leaving), "the turn must end while the card is still fading, or this pins nothing")

    // The fade runs to its end on the card it started on: opacity only ever falls, the box never changes,
    // and the reply is not painted into a card that is on its way out.
    for (let i = 1; i < fading.length; i++) assert.ok(fading[i].op! <= fading[i - 1].op! + 0.011, `the fade restarted or reversed at ${fading[i].t}ms: ${fading[i - 1].op} → ${fading[i].op}`)
    assert.ok(fading.at(-1)!.op! <= 0.1, `the card was cut mid-fade, at opacity ${fading.at(-1)!.op} (${fading.at(-1)!.t}ms)`)
    assert.equal(new Set(fading.map((f) => f.h)).size, 1, `the fading card changed height: ${JSON.stringify([...new Set(fading.map((f) => f.h))])}`)
    assert.deepEqual(fading.filter((f) => f.reply), [], "the reply was painted into the card while it faded")

    // Then it comes back once — mounted, opaque, with its reply — and stays: no blank slot, no second exit.
    const lastFade = frames.lastIndexOf(fading.at(-1)!)
    const after = frames.slice(lastFade + 1)
    const back = after.filter((f) => f.present)
    assert.ok(back.length > 20, `the card must come back to the queue: ${back.length} frames with it mounted after the fade`)
    assert.ok(back[0].t - fading.at(-1)!.t < 400, `the card came back late: ${fading.at(-1)!.t}ms → ${back[0].t}ms`)
    assert.deepEqual(after.slice(after.indexOf(back[0])).filter((f) => !f.present || f.leaving), [], "the returned card left again")
    assert.deepEqual(back.filter((f) => !f.reply || f.op !== 1), [], "the returned card painted without its reply, or less than opaque")
    assert.equal(new Set(back.map((f) => f.h)).size, 1, `the returned card changed height after it mounted: ${JSON.stringify([...new Set(back.map((f) => f.h))])}`)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
