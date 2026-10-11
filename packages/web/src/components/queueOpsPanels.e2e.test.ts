import assert from "node:assert/strict"
import test from "node:test"

// EACH COUNT OVER A PROMPT BOX OPENS ITS OWN PANEL (maintainer 2026-10-11: "there should be a popover
// for each of the different categories … If you hover over Files, it should show the files. If you
// hover over the pull request watchers, it should show the pull request"). Until then the whole line
// was one control over one panel listing every row. Hover, the pointer's path into a panel and the
// keyboard's way in are all browser facts, so they are driven in one against the real queue card.
//
//   nub run test:e2e -- queueOpsPanels.e2e.test.ts
const baseUrl = process.env.FRIZZ_QUEUE_OPS_PANELS_E2E_URL

// The fixture's rows, by the count that must list them (queue-ops-spacing-fixture.tsx).
const ROWS = {
  agent: ["Diff the queue card against the drawer footer"],
  shell: ["Poll panes for perm-prompt false positives", "Poll panes for near-miss perm markers", "Record 5min of frizz board SSE"],
  pr: ["colinhacks/zod#6559", "nubjs/nub#874"],
  issue: ["colinhacks/frizz#61"],
  file: ["Structured restriction report", "HKS pair-merge report"],
  link: ["Dev server"],
} as const
type Kind = keyof typeof ROWS
const KINDS = Object.keys(ROWS) as Kind[]

test("each op count opens a panel of its own rows, one panel at a time", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"], protocolTimeout: 30_000 })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text()) })
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/queue-ops-spacing-fixture.html?agents=1&links=1&watches=1`, { waitUntil: "networkidle0" })
    await page.evaluate(() => { document.documentElement.dataset.font = "sans" })
    await page.waitForSelector("[data-queue-ops-summary] [data-ops-count]")

    const count = (kind: Kind) => `[data-queue-ops-summary] [data-ops-count="${kind}"]`
    const panel = (kind: Kind) => `[data-queue-ops-panel="${kind}"]`
    const openPanels = () => page.$$eval("[data-queue-ops-panel]", (els) => els.map((el) => (el as HTMLElement).dataset.queueOpsPanel))
    const assertOnly = async (kind: Kind) => {
      await page.waitForSelector(panel(kind))
      // The panel a pointer just left unmounts with the same render that mounts the next one.
      await page.waitForFunction(() => document.querySelectorAll("[data-queue-ops-panel]").length === 1)
      const text = await page.$eval(panel(kind), (el) => (el as HTMLElement).innerText)
      for (const row of ROWS[kind]) assert.ok(text.includes(row), `the ${kind} panel lists "${row}", got ${JSON.stringify(text)}`)
      for (const other of KINDS.filter((k) => k !== kind)) {
        for (const row of ROWS[other]) assert.ok(!text.includes(row), `the ${kind} panel must not list the ${other} row "${row}"`)
      }
    }

    assert.deepEqual(
      await page.$$eval("[data-queue-ops-summary] [data-ops-count]", (els) => els.map((el) => (el as HTMLElement).innerText.replace(/\s+/g, " ").trim())),
      ["1 agent", "3 shells", "2 PRs", "1 issue", "2 files", "1 link"],
    )
    assert.deepEqual(await openPanels(), [], "nothing is open until a count is hovered")

    // 1. Hover: every count, left to right. Going straight from one to the next swaps the panel.
    for (const kind of KINDS) {
      await page.hover(count(kind))
      await assertOnly(kind)
      assert.equal(await page.$eval(count(kind), (el) => el.getAttribute("aria-expanded")), "true")
    }

    // 2. The pointer can cross the gap into the panel and stay there: the rows are controls.
    await page.hover(count("shell"))
    await assertOnly("shell")
    const from = (await (await page.$(count("shell")))!.boundingBox())!
    const into = (await (await page.$(panel("shell")))!.boundingBox())!
    assert.ok(into.y + into.height <= from.y, "the panel stands above its count")
    await page.mouse.move(from.x + from.width / 2, into.y + into.height - 12, { steps: 12 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.deepEqual(await openPanels(), ["shell"], "the panel survives the pointer moving into it")
    // …and a row in it is a real control: the stale shell still offers its ×.
    assert.ok(await page.$(`${panel("shell")} button[aria-label="Clear background shell: Poll panes for perm-prompt false positives"]`), "the shell rows keep their ×")

    // 3. Leaving both closes it.
    await page.mouse.move(4, 4)
    await page.waitForFunction(() => !document.querySelector("[data-queue-ops-panel]"))

    // 4. A press on a count opens, never toggles: the hover already opened it.
    await page.click(count("pr"))
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(await openPanels(), ["pr"], "a click on the hovered count leaves its panel open")
    await page.mouse.move(4, 4)
    await page.waitForFunction(() => !document.querySelector("[data-queue-ops-panel]"))

    // 5. The keyboard: focus opens, Tab moves to the next count and swaps the panel, ↓ goes into the
    // panel, Escape comes back to the count and closes it. REAL Tab presses carry the focus, never
    // `element.focus()`: a focus the browser dispatches lets React commit the panel before the event
    // reaches the document, and that is the path on which a panel opened and shut in one keystroke.
    await page.focus(count("issue"))
    await page.keyboard.press("Tab")
    await assertOnly("file")
    await page.keyboard.press("Tab")
    await assertOnly("link")
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(await openPanels(), ["link"], "the panel a Tab opened stays open")
    await page.keyboard.press("ArrowDown")
    await page.waitForFunction(() => !!document.activeElement?.closest('[data-queue-ops-panel="link"]'))
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-queue-ops-panel]"))
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.opsCount), "link", "Escape returns focus to the count")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// THE LINE SITS IN THE MIDDLE OF THE SPACE IT IS IN: as far under the rule above the dock as it is over
// the prompt box. It hung 4.6px low until 2026-10-11 (maintainer: "there's more space above the artifact
// chips than below"). Measured on the cap band — baseline to cap height, which is what the eye reads as
// the line of text and what the digits fill — because the counts' boxes carry leading the eye never sees.
test("the op counts stand midway between the dock's rule and the prompt box", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"], protocolTimeout: 30_000 })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 1 })
    for (const fixture of ["queue-ops-spacing-fixture.html?agents=1&links=1&watches=1", "drawer-composer-footer-fixture.html"]) {
      await page.goto(`${baseUrl}/${fixture}`, { waitUntil: "networkidle0" })
      await page.evaluate(() => { document.documentElement.dataset.font = "sans" })
      await page.waitForSelector("[data-queue-ops-summary] [data-ops-count]")
      const bands = await page.$eval("[data-queue-ops-summary]", (summary) => {
        const bar = summary.parentElement!
        let ruled: HTMLElement = bar
        while (parseFloat(getComputedStyle(ruled).borderTopWidth) === 0) ruled = ruled.parentElement!
        const rule = ruled.getBoundingClientRect().top + parseFloat(getComputedStyle(ruled).borderTopWidth)
        const box = bar.querySelector<HTMLElement>(".group.relative.rounded-xl")!.getBoundingClientRect().top
        return [...summary.querySelectorAll<HTMLElement>("[data-ops-count]")].map((count) => {
          const label = count.lastElementChild as HTMLElement
          // A zero-size inline-block's bottom edge is the baseline of the inline context it sits in.
          const probe = document.createElement("span")
          probe.style.cssText = "display:inline-block;width:0;height:0"
          label.appendChild(probe)
          const baseline = probe.getBoundingClientRect().bottom
          probe.remove()
          const style = getComputedStyle(label)
          const canvas = document.createElement("canvas").getContext("2d")!
          canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
          const cap = canvas.measureText("H").actualBoundingBoxAscent
          return { above: baseline - cap - rule, below: box - baseline, gap: box - rule }
        })
      })
      assert.ok(bands.length > 0)
      for (const band of bands) {
        assert.equal(band.gap, 32, `${fixture}: the prompt box stands 32px under the rule`)
        assert.ok(Math.abs(band.above - band.below) < 0.5, `${fixture}: ${band.above.toFixed(2)}px above the counts against ${band.below.toFixed(2)}px below`)
      }
    }
  } finally {
    await browser.close()
  }
})
