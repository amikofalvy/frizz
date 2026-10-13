import assert from "node:assert/strict"
import test from "node:test"

// Opt-in, like every other e2e here: start `vite` in packages/web and point this at its origin (or run
// `nub run test:e2e`, which does both).
//   cd packages/web && nubx vite --port 5233 --strictPort --host 127.0.0.1 &
//   FRIZZ_SIGNAL_CARD_HEADS_E2E_URL=http://127.0.0.1:5233 nub --test src/components/signalCardHeads.e2e.test.ts
const baseUrl = process.env.FRIZZ_SIGNAL_CARD_HEADS_E2E_URL

// ONE HEAD FOR EVERY SIGNAL CARD (2026-10-13). The steps card alone wore the kind chip and its rule, and
// the done card kept the glyph-beside-title head beside it (maintainer: "it's weird that the done blocks
// still don't have a visually separate header, the way that the awaiting blocks do. We need consistency
// here in our … block types"). Drawn against the real FenceCard in fence-card-gallery-fixture.html, every
// done and awaiting shape it carries:
//
//   1. heads with a kind chip, ruled off from its body — and the rule sits the same ink distance under a
//      bare chip on every kind, as does the body's first line under the rule;
//   2. sets its chip glyph at the same INK inset and the same ink gap to its label on every kind, though
//      Check, Hourglass and TerminalSquare each carry different dead space in their boxes;
//   3. draws no rule over a bare done card, whose Mark-as-done band is then the only seam, at the rule's distance.
test("every done and awaiting card wears the chip head, at one rhythm", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error" && !/favicon/i.test(m.text())) errors.push(m.text()) })
    await page.setViewport({ width: 720, height: 1200, deviceScaleFactor: 2 })
    await page.goto(`${baseUrl}/fence-card-gallery-fixture.html`, { waitUntil: "networkidle0" })
    await page.evaluate(() => { document.documentElement.dataset.font = "sans" })
    await page.waitForSelector("[data-fence-section] [data-card-chip]")
    const cards = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-fence-section]")].map((section) => {
      const chip = section.querySelector<HTMLElement>("[data-card-chip]")!
      const rule = section.querySelector<HTMLElement>("[data-card-rule]")
      const body = section.querySelector<HTMLElement>(".card-md")
      const svg = chip.querySelector("svg")!
      // An SVG geometry child's client rect is its ink (stroke excluded) — the same frame every reading
      // in TranscriptCard's comments was taken in.
      const inks = [...svg.querySelectorAll("path,rect,circle,line,polyline,polygon")].map((g) => g.getBoundingClientRect())
      const ink = { left: Math.min(...inks.map((r) => r.left)), right: Math.max(...inks.map((r) => r.right)) }
      const label = [...chip.childNodes].find((n) => n.nodeType === 3)!
      const range = document.createRange()
      range.selectNodeContents(label)
      const chipBox = chip.getBoundingClientRect()
      return {
        slug: section.dataset.fenceSection!,
        chip: chip.textContent,
        titled: !!section.querySelector("[data-card-title]"),
        chipToRule: rule ? rule.getBoundingClientRect().top - chipBox.bottom : null,
        order: rule && body ? chipBox.top < rule.getBoundingClientRect().top && rule.getBoundingClientRect().top < body.getBoundingClientRect().top : null,
        chipToBand: (() => { const band = section.querySelector("[data-card-actions]"); return band ? band.getBoundingClientRect().top - chipBox.bottom : null })(),
        glyphInset: ink.left - chipBox.left,
        glyphGap: range.getBoundingClientRect().left - ink.right,
      }
    }))
    const by = (slug: string) => cards.find((c) => c.slug === slug)!
    assert.ok(cards.length >= 10, `the gallery draws its signal cards (${cards.length})`)

    // 1. Chip → rule → body on every card with a body, and one distance under a bare chip.
    assert.equal(by("g-done").chip, "Done")
    assert.equal(by("g-shell-midturn").chip, "Background shells running")
    assert.ok(cards.filter((c) => c.chip === "Awaiting").length >= 5, "the generic awaiting shapes chip as Awaiting")
    for (const c of cards.filter((c) => c.slug !== "g-done-empty")) {
      assert.equal(c.order, true, `${c.slug}: chip, then the rule, then the body`)
      if (!c.titled) assert.ok(Math.abs(c.chipToRule! - 17) < 0.5, `${c.slug}: 17px from a bare chip to the rule (${c.chipToRule})`)
    }

    // 2. One ink inset and one ink gap, whatever the glyph.
    const insets = new Set(cards.map((c) => c.glyphInset.toFixed(1)))
    const gaps = new Set(cards.map((c) => c.glyphGap.toFixed(1)))
    assert.equal(insets.size, 1, `one glyph ink inset across ${[...new Set(cards.map((c) => c.chip))].join(", ")}: ${[...insets]}`)
    assert.equal(gaps.size, 1, `one glyph-to-label ink gap: ${[...gaps]}`)

    // 3. A bare done: its chip and its band, and no rule between them.
    const empty = by("g-done-empty")
    assert.equal(empty.chip, "Done")
    assert.equal(empty.chipToRule, null, "no rule over a card with no body")
    assert.ok(empty.chipToBand !== null && Math.abs(empty.chipToBand - 17) < 0.5, `the band's border sits where the rule would, 17px under the chip (${empty.chipToBand})`)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
