import assert from "node:assert/strict"
import test from "node:test"

// Point at the BOARD URL of an isolated adhoc-stack, never the live instance. Only the supervisor
// is simulated: the real App chooses its shell and renders the shared update/restart control.
const url = process.env.FRIZZ_MOBILE_UPDATE_E2E_URL

test("the real mobile shell exposes update/restart and keeps failure recovery reachable", { skip: !url, timeout: 90_000 }, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--use-mock-keychain"] })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", error => errors.push(String(error)))
    let current = false
    let unavailable = false
    let requests = 0
    let patch = false
    await page.setRequestInterception(true)
    page.on("request", async request => {
      const path = new URL(request.url()).pathname
      if (path === "/_frizz/control/status") {
        return request.respond({ status: unavailable ? 404 : 200, contentType: "application/json", body: JSON.stringify({
          protocol: 1, state: "ready", updateRestart: true, updateAvailable: !current,
          version: "0.13.8", updateVersion: current ? undefined : patch ? "0.13.9" : "0.14.0",
        }) })
      }
      if (path === "/_frizz/control/update-restart") {
        requests++
        await new Promise(resolve => setTimeout(resolve, 500))
        return request.respond({ status: 500, contentType: "application/json", body: "{}" })
      }
      return request.continue()
    })
    const load = async (width: number) => {
      // Dismiss the sheet's history entry before navigating to another fixture state. Otherwise its
      // unmount cleanup races the document navigation with history.back() across the shell boundary.
      if (await page.$('[data-mobile-more-sheet]')) {
        await page.keyboard.press("Escape")
        await page.waitForSelector('[data-mobile-more-sheet]', { hidden: true })
      }
      await page.setViewport({ width, height: 844 })
      await page.goto(url!, { waitUntil: "networkidle2" })
      await page.waitForSelector(width <= 700 ? "[data-mobile-board]" : "[data-status-row]")
    }
    const openMenu = async () => {
      await page.click("[data-mobile-more]")
      await page.waitForSelector("[data-mobile-more-sheet]")
      await page.waitForFunction(() => {
        const r = document.querySelector("[data-mobile-more-sheet]")!.getBoundingClientRect()
        return r.top < innerHeight && r.bottom <= innerHeight + 0.5
      })
    }
    for (const width of [320, 390, 640, 700, 701, 1440]) {
      await load(width)
      if (width <= 700) {
        assert.equal(await page.$('button[aria-label="Update Frizz"]'), null, "no standalone update action in navigation")
        await page.waitForSelector("[data-mobile-update-notification]")
        assert.match(await page.$eval("[data-mobile-more]", el => el.getAttribute("aria-label")!), /update available/)
        await openMenu()
      }
      await page.waitForSelector('button[aria-label="Update Frizz"]')
      assert.equal((await page.$$('button[aria-label="Update Frizz"]')).length, 1)
      if (width > 700) continue
      const rect = await page.$eval('button[aria-label="Update Frizz"]', el => {
        const r = el.getBoundingClientRect()
        return { x: r.x, right: r.right, width: r.width, height: r.height }
      })
      assert.ok(rect.width >= 44 && rect.height >= 48)
      assert.ok(rect.x >= 0 && rect.right <= width)
      assert.ok(await page.$("[data-mobile-update-row] [data-mobile-update-row-notification]"))
      assert.equal(await page.$("[data-mobile-settings-row] [data-mobile-update-row-notification]"), null)
      assert.equal(await page.$('[role="tooltip"]'), null)
    }
    await load(390)
    await openMenu()
    await page.click('button[aria-label="Update Frizz"]')
    await page.waitForSelector('[role="alertdialog"]')
    assert.ok(await page.$("[inert]"), "updating blocks background interaction")
    await page.waitForSelector('[role="alert"]')
    assert.equal(requests, 1)
    await page.click('button[aria-label="Dismiss"]')
    assert.equal(await page.$('[role="alert"]'), null)
    current = true
    await load(390)
    assert.equal(await page.$("[data-mobile-update-notification]"), null)
    await openMenu()
    await page.waitForSelector('button[aria-label="Frizz is up to date"]')
    assert.equal(await page.$eval('[data-mobile-update-row]', el => (el as HTMLButtonElement).disabled), true)
    assert.equal(await page.$("[data-mobile-update-row-notification]"), null)
    assert.equal(await page.$('button[aria-label="Update Frizz"]'), null)
    unavailable = true
    await load(390)
    await openMenu()
    assert.equal(await page.$('button[aria-label="Restart Frizz"]'), null)
    assert.equal(await page.$('[data-mobile-update-row]'), null)
    assert.ok(await page.$("[data-mobile-more]"))
    assert.equal(await page.$("[data-mobile-update-notification]"), null)
    unavailable = false; current = false; patch = true
    await load(390)
    await page.waitForSelector("[data-mobile-update-notification]")
    await openMenu()
    await page.waitForSelector('button[aria-label="Update Frizz"]')
    assert.ok(await page.$("[data-mobile-update-row-notification]"))
    await page.keyboard.press("Escape")
    await page.waitForSelector('[data-mobile-more-sheet]', { hidden: true })
    await openMenu()
    await page.goBack()
    await page.waitForSelector('[data-mobile-more-sheet]', { hidden: true })
    await openMenu()
    await page.click('[data-mobile-settings-row]')
    await page.waitForSelector('[data-mobile-settings-page]')
    assert.equal(await page.$('[data-mobile-more-sheet]'), null)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
