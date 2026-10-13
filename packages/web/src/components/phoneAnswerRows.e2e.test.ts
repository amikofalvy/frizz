import assert from "node:assert/strict"
import test from "node:test"

// Opt-in, like every other e2e here: start `vite` in packages/web and point this at its origin (or run
// `nub run test:e2e`, which does both).
//   FRIZZ_PHONE_ANSWER_ROWS_E2E_URL=http://127.0.0.1:5233 nub --test src/components/phoneAnswerRows.e2e.test.ts
const baseUrl = process.env.FRIZZ_PHONE_ANSWER_ROWS_E2E_URL

// THE ROWS OF ONE QUESTION ARE ONE HEIGHT, tagged or not. The RECOMMENDED tag is 11px type set inline on
// a 15.5px label; while it inherited the label's 21px line-height its own half-leading hung below the
// label's, the line grew to 22px, and the recommended row stood 1px taller than the rows under it
// (2026-10-13). Read off the phone's answer sheet in registered-question-fixture.html?fence=sheet, whose
// first option is the recommended one.
test("a recommended option's row is the height of the others on the phone's answer sheet", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await page.goto(`${baseUrl}/registered-question-fixture.html?fence=sheet&font=sans`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-answer-option]")
    await page.evaluate(async () => { await document.fonts.ready; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))) })
    const rows = await page.evaluate(() => [...document.querySelectorAll("[data-answer-option]")].map((row) => {
      const label = row.querySelector("span.block")!
      const tag = [...label.querySelectorAll("span")].find((s) => s.textContent === "RECOMMENDED")
      return {
        recommended: !!tag,
        labelLine: label.getBoundingClientRect().height,
        labelLineHeight: parseFloat(getComputedStyle(label).lineHeight),
        tagFontSize: tag ? getComputedStyle(tag).fontSize : null,
      }
    }))
    assert.ok(rows.some((r) => r.recommended) && rows.some((r) => !r.recommended), "a tagged row and a plain one are both drawn")
    for (const r of rows) assert.equal(r.labelLine, r.labelLineHeight, `${r.recommended ? "the recommended" : "a plain"} row's label line is exactly its line-height`)
    // …and the tag was not shrunk to get there.
    assert.equal(rows.find((r) => r.recommended)!.tagFontSize, "11px")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
