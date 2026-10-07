import assert from "node:assert/strict"
import test from "node:test"

// An isolated adhoc-stack seeded by scripts/seed-done-thread.mjs. Never point at a live board.
const url = process.env.FRIZZ_MOBILE_THREAD_BACK_E2E_URL
const recordingDir = process.env.FRIZZ_MOBILE_THREAD_BACK_RECORD_DIR

test("mobile thread Back returns direct/reloaded links to their project and pops live navigation", { skip: !url, timeout: 90_000 }, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", error => errors.push(String(error)))
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    const boardPath = new URL(url!).pathname
    const threadUrl = `${url}/thread/done-thread`
    const outside = "data:text/html,<h1>Outside Frizz</h1>"
    const waitForThread = async () => {
      await page.waitForSelector("[data-mobile-thread-back]", { visible: true })
      await page.waitForFunction(() => {
        const button = document.querySelector("[data-mobile-thread-back]")!
        const r = button.getBoundingClientRect()
        return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("[data-mobile-thread-back]")
      })
    }
    const backToBoard = async () => {
      await page.click("[data-mobile-thread-back]")
      await page.waitForFunction(path => location.pathname === path && !document.querySelector("[data-mobile-thread-back]"), {}, boardPath)
      assert.ok(await page.$("[data-mobile-board]"))
    }
    const openFromBoard = async () => {
      await page.click('[data-mobile-tab="done"]')
      await page.waitForSelector('[data-mobile-thread-row="done-thread"]')
      await page.click('[data-mobile-thread-row="done-thread"]')
      await waitForThread()
    }

    // No Frizz entry underneath: a notification/bookmark arriving from another site.
    await page.goto(outside)
    await page.goto(threadUrl, { waitUntil: "networkidle2" })
    await waitForThread()
    await backToBoard()
    await page.click("[data-mobile-projects]")
    await page.waitForFunction(() => location.pathname === "/")
    await page.waitForSelector("[data-mobile-projects-page]")

    // A live push pops, rather than rewriting a second board entry into the history stack.
    await page.goto(outside)
    await page.goto(url!, { waitUntil: "networkidle2" })
    await openFromBoard()
    await backToBoard()
    await page.goBack({ waitUntil: "load" })
    assert.equal(page.url(), outside)

    // A sheet's same-URL entry survives reload, but its UI and navigation identity do not.
    await page.goto(url!, { waitUntil: "networkidle2" })
    await openFromBoard()
    await page.click("[data-mobile-thread-more]")
    await page.waitForFunction(() => history.state?.frizzLayer)
    await page.reload({ waitUntil: "networkidle2" })
    await waitForThread()
    const recorder = recordingDir ? await page.screencast({ path: `${recordingDir}/fixed-back.webm` }) : undefined
    try {
      if (recorder) await new Promise(resolve => setTimeout(resolve, 800))
      await backToBoard()
      if (recorder) {
        await new Promise(resolve => setTimeout(resolve, 800))
        await page.screenshot({ path: `${recordingDir}/fixed-board.png` })
      }
    } finally {
      await recorder?.stop()
    }

    await openFromBoard()
    await page.reload({ waitUntil: "networkidle2" })
    await waitForThread()
    await backToBoard()
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
