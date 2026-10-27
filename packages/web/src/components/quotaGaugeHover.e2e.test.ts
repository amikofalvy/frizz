import assert from "node:assert/strict"
import test from "node:test"

// The fuel gauge's breakdown opens the INSTANT the pointer reaches the gauge (maintainer 2026-10-26: "we
// need an immediate popover to show on the usage gauge when hovered"), stays open while the pointer
// crosses into it, shuts when the pointer leaves — and a hover costs no forced quota read, which only a
// click may spend. Hover timing, Radix's outside-interaction dismissal and the RPCs a gesture sends are
// all things a static render cannot see, so this drives the status-row fixture in a real browser.
//
//   cd packages/web && nubx vite --port 5947 --strictPort
//   FRIZZ_QUOTA_GAUGE_E2E_URL=http://127.0.0.1:5947 nub run test packages/web/src/components/quotaGaugeHover.e2e.test.ts
const baseUrl = process.env.FRIZZ_QUOTA_GAUGE_E2E_URL

test("hovering the fuel gauge opens its breakdown at once, and only a click rechecks", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))
  // Every quota read the page sends, by its `?input=`: none for the poll, `{"force":"claude"}` for a
  // recheck (quota is a query, so its input rides the URL).
  // Counted IN the page: the fixture answers RPCs from its own `window.fetch` override, so they never
  // reach the network. The trap wraps whatever the fixture installs, so its stubs still answer.
  await page.evaluateOnNewDocument(() => {
    const reads: string[] = ((window as unknown as { __quotaReads: string[] }).__quotaReads = [])
    let current = window.fetch
    Object.defineProperty(window, "fetch", {
      configurable: true,
      get: () => current,
      set: (installed: typeof fetch) => {
        current = (input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          const parsed = new URL(url, location.href)
          if (parsed.pathname === "/_frizz/rpc/quota") reads.push(parsed.searchParams.get("input") ?? "")
          return installed(input, init)
        }
      },
    })
  })
  const quotaReads = () => page.evaluate(() => (window as unknown as { __quotaReads: string[] }).__quotaReads)
  const forced = async () => (await quotaReads()).filter((body) => body.includes("force")).length

  const gauge = "[data-quota-gauge]"
  const panel = "[data-quota-panel]"
  const panelOpen = () => page.$(panel).then((el) => el !== null)

  try {
    await page.setViewport({ width: 700, height: 500, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/status-row-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(gauge)
    const box = (await (await page.$(gauge))!.boundingBox())!
    // Park the pointer well away from the row first, so the hover below is a real entry.
    await page.mouse.move(10, 480)
    assert.equal(await panelOpen(), false, "closed at rest")

    // IMMEDIATE: the panel is in the document by the next frame after the pointer arrives — no open
    // delay, the way a tooltip or a GitHub hovercard waits.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    assert.equal(
      await page.evaluate((sel) => new Promise<boolean>((resolve) => requestAnimationFrame(() => resolve(document.querySelector(sel) !== null))), panel),
      true,
      "the breakdown opens on the frame the pointer reaches the gauge",
    )
    assert.equal(await page.$eval(gauge, (el) => el.getAttribute("aria-expanded")), "true")
    assert.equal(await page.$eval(gauge, (el) => el.getAttribute("title")), null, "no native tooltip to arrive late on top of the panel")
    assert.match(await page.$eval(panel, (el) => (el as HTMLElement).innerText), /5h[\s\S]*% left[\s\S]*Weekly/, "it is the full per-window breakdown")
    // The hover leaves focus where it was: the panel must not pull the caret out of the prompt box.
    assert.equal(await page.evaluate((sel) => document.querySelector(sel)!.contains(document.activeElement), panel), false)

    // The pointer can cross the gap into the panel (its account address is selectable) and stay there.
    const panelBox = (await (await page.$(panel))!.boundingBox())!
    await page.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + panelBox.height / 2, { steps: 4 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(await panelOpen(), true, "moving into the panel keeps it open")

    // Leaving both shuts it after the short grace.
    await page.mouse.move(10, 480)
    await page.waitForFunction((sel) => document.querySelector(sel) === null, { timeout: 2_000 }, panel)
    assert.equal(await forced(), 0, "a hover forces no quota read — that spends the usage endpoint's per-token budget")

    // A CLICK is the recheck, and it opens the panel rather than toggling the hover's panel shut.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForSelector(panel)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(await panelOpen(), true, "a click after the hover leaves the panel open")
    assert.equal(await forced(), 1, "the click forces exactly one recheck")
    assert.match((await quotaReads()).at(-1)!, /"force":"claude"/, "…of the selected model's provider")

    // Escape shuts it with the pointer still on the gauge.
    await page.keyboard.press("Escape")
    await page.waitForFunction((sel) => document.querySelector(sel) === null, { timeout: 2_000 }, panel)

    // The keyboard reaches the same panel: focusing the gauge opens it, and tabbing on past it shuts it.
    await page.mouse.move(10, 480)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.focus(gauge)
    await page.waitForSelector(panel)
    await page.keyboard.press("Tab")
    await page.waitForFunction((sel) => document.querySelector(sel) === null, { timeout: 2_000 }, panel)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
