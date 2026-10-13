import assert from "node:assert/strict"
import test from "node:test"

// Opt-in, like every other e2e here: start `vite` in packages/web and point this at its origin (or run
// `nub run test:e2e`, which does both).
//   cd packages/web && nubx vite --port 5234 --strictPort --host 127.0.0.1 &
//   FRIZZ_SETTLED_STEPS_E2E_URL=http://127.0.0.1:5234 nub --test src/components/settledSteps.e2e.test.ts
const baseUrl = process.env.FRIZZ_SETTLED_STEPS_E2E_URL

// A STEPS CARD OUTLIVES ITS REST (2026-10-08, maintainer: "We need to continue showing the to do
// instructions even after they are complete & the thread has moved on"). Every other settled ```awaiting
// fence draws nothing; one that handed the human `steps:` keeps its card, minus the box nobody is waiting
// on any more. Pinned in the real drawer (settled-steps-fixture.html), whose transcript also holds
// an earlier settled shell wait — the negative control, which must stay invisible in every state.

const CARD = "[data-awaiting-background]"
const STEPS = [
  "Run npm login --auth-type=web in a terminal on this machine.",
  "Approve the browser prompt with the acme-bot account.",
]

test("a steps card stays in the transcript after its rest, with no box", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.setViewport({ width: 900, height: 1000 })

    const read = async (at: string) => {
      await page.goto(`${baseUrl}/settled-steps-fixture.html?at=${at}`, { waitUntil: "networkidle0" })
      await page.waitForSelector(`${CARD} [data-awaiting-steps] li`)
      return page.evaluate((sel) => {
        const cards = [...document.querySelectorAll(sel)] as HTMLElement[]
        return {
          cards: cards.map((el) => ({
            chip: (el.querySelector("[data-card-chip]") as HTMLElement | null)?.innerText.trim(),
            title: (el.querySelector("[data-card-title]") as HTMLElement | null)?.innerText.trim(),
            steps: [...el.querySelectorAll("[data-awaiting-steps] .frizz-step-text")].map((li) => (li as HTMLElement).innerText.trim()),
            // The box answers only while the thread rests on these steps; a settled card is a record.
            box: !!el.querySelector("[data-steps-complete]"),
            // The card's own Send, drawn only where no prompt box sends the box for it.
            send: !!el.querySelector("[data-steps-send]"),
            // The step markers are never controls of their own.
            markerControls: el.querySelectorAll("[data-awaiting-steps] button").length,
          })),
          // The earlier settled shell wait — card AND prose — must be gone.
          shellProse: document.body.innerText.includes("The release build is running in the background."),
          // …while the steps fence's own prose rides its card, once.
          stepsProse: document.body.innerText.split("The 4.2.0 tag is cut and verified.").length - 1,
          doneBubble: [...document.querySelectorAll("[data-transcript-source-id='u2']")].length,
        }
      }, CARD)
    }

    const stepsCard = { chip: "Awaiting human", title: "Sign in to npm so the acme 4.2.0 release can publish", steps: STEPS }

    // AT REST on the steps: the tail's resting card states them, WITH the box — and the transcript does
    // not draw them a second time above it.
    const rest = await read("rest")
    assert.deepEqual(rest.cards, [{ ...stepsCard, box: true, send: false, markerControls: 0 }], "one card, the live one, with its box — and the drawer's prompt box to send it")
    assert.equal(rest.shellProse, false, "a settled shell wait still draws nothing")
    assert.equal(rest.stepsProse, 1)

    // Every reply the page sends, by its words.
    const recordSends = () => page.evaluate(() => {
      const w = window as unknown as { __sent: string[] }
      w.__sent = []
      const inner = window.fetch
      window.fetch = async (input, init) => {
        if (String(input instanceof Request ? input.url : input).includes("/_frizz/rpc/followUp")) w.__sent.push(String(JSON.parse(String(init?.body ?? "{}")).message))
        return inner(input, init)
      }
    })
    const sent = () => page.evaluate(() => (window as unknown as { __sent: string[] }).__sent)
    const tick = async () => {
      await page.click("[data-steps-complete] button[role=checkbox]")
      await page.waitForFunction(() => document.querySelector("[data-steps-complete] button[role=checkbox]")?.getAttribute("aria-checked") === "true")
    }

    // THE DRAWER'S PROMPT BOX sends the ticked box, as the queue card's does.
    await recordSends()
    await tick()
    await page.click("[data-send-split] [data-send]")
    await page.waitForFunction(() => (window as unknown as { __sent: string[] }).__sent.length > 0, { timeout: 10_000 })
    assert.deepEqual(await sent(), ["Done"], "one reply, the word")

    // ON A PHONE the bar under the drawer sends no answers (they have their own sheet), so the card draws
    // its own Send — dark until the box is ticked, and then the same ordinary reply.
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    const phone = await read("rest&drawer=1")
    assert.deepEqual(phone.cards, [{ ...stepsCard, box: true, send: true, markerControls: 0 }], "the card's own Send, where nothing else sends the box")
    await recordSends()
    assert.equal(await page.$eval("[data-steps-send]", (b) => (b as HTMLButtonElement).disabled), true, "nothing ticked, nothing to send")
    await tick()
    await page.click("[data-steps-send]")
    await page.waitForFunction(() => (window as unknown as { __sent: string[] }).__sent.length > 0, { timeout: 10_000 })
    assert.deepEqual(await sent(), ["Done"], "one reply, the word")
    await page.setViewport({ width: 900, height: 1000 })

    // SENT, worker mid-turn: the card stays where it was, without the box.
    const running = await read("running")
    assert.deepEqual(running.cards, [{ ...stepsCard, box: false, send: false, markerControls: 0 }], "the steps stay, and nobody is waiting on their box")
    assert.equal(running.shellProse, false)
    assert.equal(running.stepsProse, 1)

    // THE THREAD MOVED ON to a later rest: still there, still no box, beside the new resting card.
    const moved = await read("moved")
    assert.equal(moved.cards.length, 2, "the settled steps card and the new resting card")
    assert.deepEqual(moved.cards[0], { ...stepsCard, box: false, send: false, markerControls: 0 })
    assert.equal(moved.cards[1].steps.length, 0, "the later rest is a plain wait")
    assert.equal(moved.shellProse, false)
    assert.equal(moved.stepsProse, 1)

    assert.deepEqual(errors, [], "no console or page errors")
  } finally {
    await browser.close()
  }
})
