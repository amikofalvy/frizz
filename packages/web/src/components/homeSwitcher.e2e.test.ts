import assert from "node:assert/strict"
import test from "node:test"

// THE HOME SWITCHER (HomeSwitcher.tsx) and the grid's forward to a kept Console (routes.tsx GridRoute).
//
//   · Its tabs are links: each has the address it goes to, so hovering one shows it and ⌘-click opens it.
//     They were buttons until 2026-10-23.
//   · The lit tab is the page on screen. It read the kept home, which every tab shares through the
//     storage event, so choosing Projects in one tab lit "Projects" over the Console in another.
//   · The Projects tab's address reaches the grid even while the Console is the kept home, opened in a
//     new tab as well as clicked, and the grid records the choice.
//   · Only a bare `/` forwards to the kept Console: the launcher's `/?add=<dir>` offer reached the grid's
//     dialog only while Projects was the kept home.
//
// Real server, one project (nothing is dispatched):
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<throwaway repo>
//   FRIZZ_HOME_SWITCHER_E2E_URL=http://127.0.0.1:<port> FRIZZ_HOME_SWITCHER_E2E_ADD_DIR=<another repo, not added> \
//     nub run test <this file>
const baseUrl = process.env.FRIZZ_HOME_SWITCHER_E2E_URL
const addDir = process.env.FRIZZ_HOME_SWITCHER_E2E_ADD_DIR

const KEY = "frizz:home-view"
const TABS = "[data-home-tab]"

type Page = import("puppeteer").Page

const tabsOf = (page: Page) =>
  page.$$eval(TABS, (els) =>
    els.map((el) => ({ tag: el.tagName, tab: el.getAttribute("data-home-tab"), href: el.getAttribute("href"), selected: el.getAttribute("aria-selected") })),
  )
const lit = async (page: Page) => (await tabsOf(page)).filter((t) => t.selected === "true").map((t) => t.tab)
const kept = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY)
const at = (page: Page) => page.evaluate(() => location.pathname + location.search)
const onGrid = (page: Page) => page.waitForFunction(() => location.pathname === "/" && document.querySelector("h1")?.textContent === "Select a project", { timeout: 15_000 })

test("the home switcher's tabs are links, and the lit tab is the page on screen", { skip: !baseUrl || !addDir, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  const open = async () => {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    page.on("pageerror", (e) => errors.push(String(e)))
    return page
  }
  try {
    // One browser, so the pages share localStorage and see each other's storage events, as two tabs do.
    const here = await open()
    await here.goto(`${baseUrl}/console`, { waitUntil: "networkidle2" })
    await here.waitForSelector('[data-home-tab="console"][aria-selected="true"]')
    assert.equal(await kept(here), "console", "arriving on the Console keeps it as home")
    assert.deepEqual(await tabsOf(here), [
      { tag: "A", tab: "projects", href: "/?home=projects", selected: "false" },
      { tag: "A", tab: "console", href: "/console", selected: "true" },
    ])
    const house = '[data-status-row] a[aria-label]'
    assert.equal(await here.$eval(house, (a) => a.getAttribute("href")), "/console", "the house goes to the kept Console")

    // A bare `/` still forwards to the kept Console.
    const other = await open()
    await other.goto(`${baseUrl}/`, { waitUntil: "networkidle2" })
    await other.waitForFunction(() => location.pathname === "/console", { timeout: 15_000 })

    // The other tab clicks Projects: it lands on the grid at a plain `/`, Projects lit and kept.
    await other.waitForSelector('[data-home-tab="projects"]')
    await other.click('[data-home-tab="projects"]')
    await onGrid(other)
    await other.waitForFunction((key) => localStorage.getItem(key) === "projects" && location.search === "", { timeout: 5_000 }, KEY)
    assert.deepEqual(await lit(other), ["projects"])

    // This tab, still on the Console, hears the choice — its house now goes to the grid — and keeps
    // Console lit, because Console is what it shows.
    await here.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("href") === "/", { timeout: 5_000 }, house)
    assert.equal(await at(here), "/console")
    assert.deepEqual(await lit(here), ["console"], "another tab's choice does not light Projects over this Console")

    // Back to the Console as home, then ⌘-click Projects: a new tab opens on the grid, not the Console,
    // and this tab stays where it is.
    await here.reload({ waitUntil: "networkidle2" })
    await here.waitForFunction((key) => localStorage.getItem(key) === "console", { timeout: 5_000 }, KEY)
    const before = new Set(browser.targets())
    await here.keyboard.down("Meta")
    await here.click('[data-home-tab="projects"]')
    await here.keyboard.up("Meta")
    const target = await browser.waitForTarget((t) => t.type() === "page" && !before.has(t), { timeout: 10_000 })
    const opened = (await target.page())!
    opened.on("pageerror", (e) => errors.push(String(e)))
    await onGrid(opened)
    await opened.waitForFunction((key) => localStorage.getItem(key) === "projects" && location.search === "", { timeout: 5_000 }, KEY)
    assert.equal(await at(here), "/console", "a ⌘-click does not navigate the tab it was made in")

    // The launcher's offer to add a folder reaches the grid's dialog while the Console is kept.
    await here.reload({ waitUntil: "networkidle2" })
    await here.waitForFunction((key) => localStorage.getItem(key) === "console", { timeout: 5_000 }, KEY)
    const offer = await open()
    await offer.goto(`${baseUrl}/?add=${encodeURIComponent(addDir!)}`, { waitUntil: "networkidle2" })
    await offer.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent?.includes("Add this folder as a project?"), { timeout: 15_000 })
    assert.equal(await offer.evaluate(() => location.pathname), "/", "the offer is not forwarded to the Console")
    assert.equal(await kept(offer), "console", "an offer is not a choice of home")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
