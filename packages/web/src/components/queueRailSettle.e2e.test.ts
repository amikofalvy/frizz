import assert from "node:assert/strict"
import test from "node:test"

// THE RAIL HOLDS STILL WHILE THE HUMAN ACTS ON THE QUEUE. Runtime coverage for the two ways it did not,
// both recorded frame by frame on 2026-10-13 against a stack whose worker is the scripted Claude:
//
//   1. A send from a queue card moved the scroll marker THREE times in ~250ms: onto the sent row in the
//      Running band for 2-3 frames (27 of 27 recordings), onto the card ABOVE for the length of the fade,
//      then onto the card below. It now moves once, to the row that takes the sent row's place, in the
//      commit that moves the row (lib/sidebarScrollspy markerRow).
//   2. A dispatch from the prompt box mounted a "Starting thread…" card between the box and the rail for
//      the length of the dispatch call: every row moved down 73px at the click and back up when the call
//      answered (5 of 5). The rail now draws the pending thread as the Running row it becomes
//      (lib/pendingDispatch), so one row appears and nothing else moves.
//
// Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts
// here): `nub run test:e2e -- queueRailSettle.e2e.test.ts`, or start `vite` in packages/web and set
// FRIZZ_QUEUE_RAIL_SETTLE_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_QUEUE_RAIL_SETTLE_E2E_URL

const ABOVE = "auth-refresh"
const SENT = "csv-export"
const BELOW = "flaky-e2e"

test("a send from a queue card hands the scroll marker to the row that takes its place — once, and never into Running", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/queue-rail-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`[data-queue-card-root="${BELOW}"]`)
    // Read the middle card with part of the one above it still on screen — the arrangement in which the
    // marker used to visit the card above while the sent card faded.
    await page.evaluate((sent: string) => {
      const card = document.querySelector<HTMLElement>(`[data-queue-card="${sent}"]`)!
      window.scrollTo(0, window.scrollY + card.getBoundingClientRect().top - 300)
    }, SENT)
    await page.waitForFunction((sent: string) => !!document.querySelector(`[data-sidebar-item="${sent}"] [data-sidebar-scroll-marker]`), { timeout: 5_000 }, SENT)

    const composer = `[data-queue-card="${SENT}"] textarea[placeholder*="reply" i]`
    await page.click(composer)
    await page.type(composer, "Carry on with the second pass.")
    await new Promise((r) => setTimeout(r, 200))

    await page.evaluate(() => {
      const w = window as unknown as { __markerFrames: { t: number; row: string | null; band: string | null }[] }
      w.__markerFrames = []
      const t0 = performance.now()
      const tick = () => {
        const marker = document.querySelector("[data-sidebar-scroll-marker]")
        const row = marker?.closest<HTMLElement>("[data-sidebar-item]") ?? null
        // The band a row sits in is the last label above it in the rail.
        let band: string | null = null
        if (row) {
          for (const el of document.querySelectorAll<HTMLElement>("[data-sidebar-rail] .uppercase, [data-sidebar-rail] [data-sidebar-item]")) {
            if (el === row) break
            if (!el.matches("[data-sidebar-item]")) band = (el.innerText ?? "").trim().split(/\s+/)[0].toLowerCase()
          }
        }
        w.__markerFrames.push({ t: +(performance.now() - t0).toFixed(1), row: row?.dataset.sidebarItem ?? null, band })
        if (performance.now() - t0 < 1200) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await page.keyboard.press("Enter")
    await page.waitForFunction((sent: string) => !document.querySelector(`[data-queue-card-root="${sent}"]`), { timeout: 5_000 }, SENT)
    await new Promise((r) => setTimeout(r, 900))
    const frames = await page.evaluate(() => (window as unknown as { __markerFrames: { t: number; row: string | null; band: string | null }[] }).__markerFrames)

    assert.ok(frames.length > 20, `expected a full sampling window, got ${frames.length} frames`)
    const path: (string | null)[] = []
    for (const f of frames) if (path.length === 0 || path[path.length - 1] !== f.row) path.push(f.row)
    assert.deepEqual(path, [SENT, BELOW], `the marker must go from the sent row straight to the row below it: ${JSON.stringify(frames.filter((f, i) => i === 0 || frames[i - 1].row !== f.row))}`)
    const strayed = frames.filter((f) => f.row !== null && f.band !== "queue")
    assert.deepEqual(strayed, [], `the marker was drawn outside the Queue band: ${JSON.stringify(strayed.slice(0, 6))}`)
    assert.equal(frames.some((f) => f.row === ABOVE), false, "the marker visited the card above while the sent card faded")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a dispatch from the prompt box adds one Running row at the click — no row above it ever moves", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  type Frame = { t: number; label: number | null; rows: Record<string, number>; starting: number | null; real: number | null; card: boolean; runningCount: string | null }
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/queue-rail-fixture.html?dispatchMs=400`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`[data-sidebar-item="${BELOW}"]`)
    const box = "aside textarea"
    await page.waitForSelector(box)
    await page.click(box)
    await page.type(box, "Audit the release pipeline for unsigned artifacts.")
    await new Promise((r) => setTimeout(r, 300))

    await page.evaluate(() => {
      const w = window as unknown as { __railFrames: unknown[] }
      w.__railFrames = []
      const t0 = performance.now()
      const top = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().top * 100) / 100 : null)
      const tick = () => {
        const rail = document.querySelector("[data-sidebar-rail]")!
        const labels = [...rail.querySelectorAll<HTMLElement>(".uppercase")]
        const rows: Record<string, number> = {}
        for (const row of rail.querySelectorAll<HTMLElement>("[data-sidebar-item]")) if (row.dataset.sidebarItem !== "started-thread") rows[row.dataset.sidebarItem!] = top(row)!
        w.__railFrames.push({
          t: +(performance.now() - t0).toFixed(1),
          label: top(labels[0] ?? null),
          rows,
          starting: top(rail.querySelector("[data-sidebar-starting]")),
          real: top(rail.querySelector('[data-sidebar-item="started-thread"]')),
          card: !!document.querySelector("aside [data-pending-dispatch]"),
          runningCount: labels.find((l) => /^running/i.test(l.innerText.trim()))?.innerText.trim().split(/\s+/)[1] ?? null,
        })
        if (performance.now() - t0 < 1500) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await page.keyboard.press("Enter")
    await page.waitForSelector('[data-sidebar-item="started-thread"]', { timeout: 5_000 })
    await new Promise((r) => setTimeout(r, 1000))
    const frames = (await page.evaluate(() => (window as unknown as { __railFrames: unknown[] }).__railFrames)) as Frame[]

    assert.ok(frames.length > 30, `expected a full sampling window, got ${frames.length} frames`)
    const first = frames[0]
    // Nothing that was in the rail moves: not the Queue label, not one of its rows.
    const moved = frames.filter((f) => f.label !== first.label || Object.entries(first.rows).some(([id, y]) => f.rows[id] !== y))
    assert.deepEqual(moved.slice(0, 4), [], "a rail row moved while the thread was starting")
    assert.equal(frames.some((f) => f.card), false, "the Starting thread… card was mounted under the prompt box")

    // The pending thread is a Running row from the click, and the real row takes exactly its place.
    const pending = frames.filter((f) => f.starting !== null)
    const landed = frames.filter((f) => f.real !== null)
    assert.ok(pending.length > 5, `the starting row must stand for the length of the dispatch call: ${pending.length} frames`)
    assert.ok(pending[0].t < 150, `the starting row appeared late: ${pending[0].t}ms`)
    assert.ok(landed.length > 5, "the thread's own row must land")
    assert.equal(new Set([...pending.map((f) => f.starting), ...landed.map((f) => f.real)]).size, 1, `the row moved when the real one replaced the stand-in: ${JSON.stringify([...new Set(pending.map((f) => f.starting))])} → ${JSON.stringify([...new Set(landed.map((f) => f.real))])}`)
    // One row throughout: never both (drawn twice), and never neither once it has appeared (a blink).
    const from = frames.indexOf(pending[0])
    const wrong = frames.slice(from).filter((f) => (f.starting !== null) === (f.real !== null))
    assert.deepEqual(wrong.slice(0, 4), [], "the stand-in and the real row were drawn together, or neither was")
    assert.deepEqual([...new Set(frames.slice(from).map((f) => f.runningCount))], ["1"], "the Running count changed while the thread was starting")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
