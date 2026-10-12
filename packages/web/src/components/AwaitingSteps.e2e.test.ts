import assert from "node:assert/strict"
import test from "node:test"

// Opt-in, like every other e2e here: start `vite` in packages/web and point this at its origin (or run
// `nub run test:e2e`, which does both).
//   cd packages/web && nubx vite --port 5233 --strictPort --host 127.0.0.1 &
//   FRIZZ_AWAITING_STEPS_E2E_URL=http://127.0.0.1:5233 nub --test src/components/AwaitingSteps.e2e.test.ts
const baseUrl = process.env.FRIZZ_AWAITING_STEPS_E2E_URL

// STEPS FOR THE HUMAN (2026-10-03): an ```awaiting fence carrying `steps:` draws them on the resting card.
// The steps render through the markdown sanitizer, which needs a real DOM, so this is pinned in a real
// browser against the real queue card (awaiting-bg-fixture.html?steps=…), its own prompt box included.
// Only the RPC answers are stubbed, in the fixture; the send itself goes through the composer's own
// eager follow-up, which is the point:
//
//   1. The card states the steps in order, as markdown, under a "Awaiting human" chip and the worker's heading
//      (the chip alone when the worker named none), ruled off from the body — in the paragraph's own
//      colour, every item on the same line height whether or not it carries a command — over ONE control,
//      the "I have completed this" box: no Snooze, no button, no text box of its own (2026-10-12).
//   2. Ticking the box STAGES an answer, as picking a question's option does: nothing is sent, the tick
//      survives a reload, the prompt box arms its Send and says it will carry a note, and a second click
//      unticks it.
//   3. The prompt box sends it — Enter in the empty box sends the word alone, and a typed note rides under
//      it in the same reply — bound to the thread's session, and the card leaves the queue.

const CARD = "[data-awaiting-background]"
const BOX = `${CARD} [data-steps-complete] button[role=checkbox]`
const COMPOSER = "textarea[data-surface='queueComposer']"
const SEND = "[data-send-split] [data-send]"

type Sent = { rpc: string; body: { slug?: string; sessionId?: string; message?: string } }

test("a steps card's one box stages an answer the prompt box sends", {
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
    await page.setViewport({ width: 900, height: 900 })
    const record = () => page.evaluate(() => {
      ;(window as unknown as { __rpc: unknown[] }).__rpc = []
      window.addEventListener("fixture-rpc", (e) => {
        ;(window as unknown as { __rpc: unknown[] }).__rpc.push((e as CustomEvent).detail)
      })
    })
    const rpcs = (name: string) => page.evaluate((n) => (window as unknown as { __rpc: Sent[] }).__rpc.filter((c) => c.rpc === n), name)
    const box = () => page.$eval(`${CARD} [data-steps-complete]`, (row) => ({
      checked: row.querySelector("button[role=checkbox]")?.getAttribute("aria-checked"),
      label: (row as HTMLElement).innerText.trim(),
    }))
    const composer = () => page.evaluate((c, s) => ({
      placeholder: (document.querySelector(c) as HTMLTextAreaElement | null)?.placeholder,
      armed: !(document.querySelector(s) as HTMLButtonElement | null)?.disabled,
    }), COMPOSER, SEND)

    // ---- an untitled card is headed by its chip alone ----
    await page.goto(`${baseUrl}/awaiting-bg-fixture.html?steps=1`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`${CARD} [data-awaiting-steps] li`)
    await page.evaluate(() => localStorage.clear())
    const untitled = await page.$eval(CARD, (el) => ({
      chip: (el.querySelector("[data-card-chip]") as HTMLElement | null)?.innerText.trim(),
      title: !!el.querySelector("[data-card-title]"),
    }))
    assert.deepEqual(untitled, { chip: "Awaiting human", title: false }, "the chip already says what the card is for")

    // ---- 1. the statement ----
    await page.goto(`${baseUrl}/awaiting-bg-fixture.html?steps=titled`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`${CARD} [data-awaiting-steps] li`)
    await record()
    const card = await page.$eval(CARD, (el) => {
      const top = (sel: string) => el.querySelector(sel)?.getBoundingClientRect().top ?? NaN
      return {
        chip: (el.querySelector("[data-card-chip]") as HTMLElement | null)?.innerText.trim(),
        title: (el.querySelector("[data-card-title]") as HTMLElement | null)?.innerText.trim(),
        glyph: el.querySelector("[data-card-chip] svg")?.getAttribute("class") ?? "",
        // chip → title → rule → body → box, top to bottom
        order: [top("[data-card-chip]"), top("[data-card-title]"), top("[data-card-rule]"), top(".card-md"), top("[data-steps-complete]")],
        proseColour: getComputedStyle(el.querySelector(".card-md p") as Element).color,
        stepColour: getComputedStyle(el.querySelector("[data-awaiting-steps] li") as Element).color,
        stepHeights: [...el.querySelectorAll("[data-awaiting-steps] .frizz-step-text")].map((t) => t.getBoundingClientRect().height),
        steps: [...el.querySelectorAll("[data-awaiting-steps] .frizz-step-text")].map((t) => (t as HTMLElement).innerText.trim()),
        code: [...el.querySelectorAll("[data-awaiting-steps] li code")].map((c) => c.textContent),
        strong: [...el.querySelectorAll("[data-awaiting-steps] li strong")].map((c) => c.textContent),
        snooze: !!el.querySelector("[data-awaiting-snooze]"),
        buttons: [...el.querySelectorAll("button:not([role=checkbox])")].map((b) => (b as HTMLElement).innerText.trim()),
        boxes: [...el.querySelectorAll("button[role=checkbox]")].map((b) => document.getElementById(b.getAttribute("aria-labelledby") ?? "")?.textContent),
        textBoxes: el.querySelectorAll("textarea, input").length,
      }
    })
    assert.equal(card.chip, "Awaiting human", "the card's kind, in its chip")
    assert.equal(card.title, "Sign in to npm so the acme 4.2.0 release can publish", "the worker's own heading, under the chip")
    assert.match(card.glyph, /lucide-list-todo/, "the to-do glyph rides inside the chip, not the hourglass beside a title")
    assert.ok(card.order.every(Number.isFinite), "the chip, the title, the rule, the body and the box are all drawn")
    assert.deepEqual([...card.order].sort((a, b) => a - b), card.order, "chip, title, rule, body, box — top to bottom")
    assert.equal(card.stepColour, card.proseColour, "one body is one colour: the steps are not brighter than the paragraph above them")
    assert.equal(new Set(card.stepHeights).size, 1, `a step carrying a command is no taller than one without (${card.stepHeights.join(", ")})`)
    assert.deepEqual(card.steps, [
      "Run npm login --auth-type=web in a terminal on this machine.",
      "Approve the browser prompt with the acme-bot account.",
      "Reply here once npm whoami prints acme-bot.",
    ], "every step, in the order the worker wrote them")
    assert.deepEqual(card.code, ["npm login --auth-type=web", "npm whoami", "acme-bot"], "a step is markdown: its code spans are code")
    assert.deepEqual(card.strong, ["acme-bot"])
    assert.equal(card.snooze, false, "the reader is the wait, so there is nothing to snooze until")
    assert.deepEqual(card.boxes, ["I have completed this"], "one box, and the step markers are not boxes of their own")
    assert.deepEqual(card.buttons, [], "no button: the prompt box under the card sends the box")
    assert.equal(card.textBoxes, 0, "and no text box of the card's own beside the prompt box")

    // ---- 2. ticking stages, and sends nothing ----
    assert.deepEqual(await box(), { checked: "false", label: "I have completed this" })
    assert.deepEqual(await composer(), { placeholder: "Reply to the agent…", armed: false }, "nothing staged, nothing typed: Send is dark")
    await page.click(BOX)
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-checked") === "true", {}, BOX)
    assert.deepEqual(await composer(), { placeholder: "Add a note to send with your answer…", armed: true }, "the ticked box is a staged answer")
    assert.equal((await rpcs("followUp")).length, 0, "a tick sends nothing")
    await page.reload({ waitUntil: "networkidle0" })
    await page.waitForSelector(BOX)
    assert.equal((await box()).checked, "true", "the tick outlives a reload")
    await page.click(BOX)
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-checked") === "false", {}, BOX)
    assert.equal((await composer()).armed, false, "and a second click unticks it")
    const stored = await page.evaluate(() => Object.keys((JSON.parse(localStorage.getItem("frizz-drafts:v1") ?? "{}") as { entries?: object }).entries ?? {}).filter((k) => k.startsWith("steps:")))
    assert.deepEqual(stored, [], "an unticked box leaves nothing behind")

    // ---- 3a. Enter in the empty prompt box sends the word alone ----
    await record()
    await page.click(BOX)
    await page.focus(COMPOSER)
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => (window as unknown as { __rpc: Sent[] }).__rpc.some((c) => c.rpc === "followUp"), { timeout: 10_000 })
    const alone = await rpcs("followUp")
    assert.equal(alone.length, 1, "one send is one reply")
    assert.equal(alone[0].body.message, "Done", "exactly the word, as if the human had typed it")
    assert.equal(alone[0].body.slug, "awaiting-bg-demo")
    assert.equal(alone[0].body.sessionId, "aaaaaaaa-bbbb-cccc-dddd-000000000001", "bound to the session that posted the steps")
    await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 10_000 }, CARD)

    // ---- 3b. a typed note rides under it, in the same reply, through the Send button ----
    await page.reload({ waitUntil: "networkidle0" })
    await page.waitForSelector(BOX)
    assert.equal((await box()).checked, "false", "the send cleared the tick")
    await record()
    await page.click(BOX)
    await page.type(COMPOSER, "Signed in as acme-bot.")
    await page.click(SEND)
    await page.waitForFunction(() => (window as unknown as { __rpc: Sent[] }).__rpc.some((c) => c.rpc === "followUp"), { timeout: 10_000 })
    const withNote = await rpcs("followUp")
    assert.equal(withNote.length, 1)
    assert.equal(withNote[0].body.message, "Done\n\nSigned in as acme-bot.", "the word, then the human's note under it")
    await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 10_000 }, CARD)

    assert.deepEqual(errors, [], "a clean console")
  } finally {
    await browser.close()
  }
})
