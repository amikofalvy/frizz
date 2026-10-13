import assert from "node:assert/strict"
import test from "node:test"

// A QUEUE CARD AT THE TWO EDGES OF A TURN IT DID NOT START, WHEN THE TRANSCRIPT REPORTS THE EDGE FIRST.
// A turn's start and its end each reach the page on two channels — a board delta and a transcript push —
// in either order, tens of milliseconds apart. The thread view reconciles them (lib/steering transcriptHold,
// lib/restAhead); the queue card read the two channels raw, and so drew the frames in between:
//
//   · TURN START (a steer from another tab, a wake, `frizzctl steer`): the landed message reached the
//     card before the board dropped the row, and the card re-cut its window to it — 816px to 308px on this
//     fixture, every card below it 508px up — and only then faded (4 of 4, 2026-10-13). lib/queueTurnAhead.
//   · TURN END, on a card whose thread is running (one with an open question keeps working): the push
//     that ends on the rest arrived while the board still said running, and the card drew the finished
//     reply with the Working row under it until the board's next tick. lib/restAhead, now on the card too.
//
// The fixture moves each channel on its own (`__pushLandedTurn` / `__pushMessages` for the transcript,
// `__patchThread` for the board), so both tests put the transcript 80ms ahead: several frames to catch.
//
// Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts
// here): `nub run test:e2e -- queueTurnEdges.e2e.test.ts`, or start `vite` in packages/web and set
// FRIZZ_QUEUE_TURN_EDGES_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_QUEUE_TURN_EDGES_E2E_URL

const CARD = "csv-export"
const BELOW = "flaky-e2e"

test("a turn opened from another tab: the card fades on the frame it was showing, whichever channel reports first", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  type Frame = { t: number; h: number | null; leaving: boolean; belowTop: number | null }
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/queue-dissolve-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`[data-queue-card-root="${BELOW}"]`)
    await new Promise((r) => setTimeout(r, 600))

    const frames = (await page.evaluate(async (card: string, below: string) => {
      const w = window as unknown as {
        __pushLandedTurn: (slug: string, text: string) => void
        __patchThread: (slug: string, patch: Record<string, unknown>) => void
      }
      const out: { t: number; h: number | null; leaving: boolean; belowTop: number | null }[] = []
      const t0 = performance.now()
      const tick = () => {
        const root = document.querySelector<HTMLElement>(`[data-queue-card-root="${card}"]`)
        const slot = document.querySelector<HTMLElement>(`[data-queue-card="${card}"]`)
        const next = document.querySelector<HTMLElement>(`[data-queue-card-root="${below}"]`)
        out.push({ t: +(performance.now() - t0).toFixed(1), h: root ? root.offsetHeight : null, leaving: slot?.dataset.queueLeaving === "true", belowTop: next ? next.offsetTop : null })
        if (performance.now() - t0 < 1200) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      await wait(100)
      // The transcript first: the other tab's message, landed…
      w.__pushLandedTurn(card, "From the other window: carry on with the narrow viewport pass.")
      await wait(80)
      // …and then the board: the thread is running and off the queue.
      const now = new Date().toISOString()
      w.__patchThread(card, { runtime: "running", needsYou: false, lastUserAt: now, lastActivityAt: now })
      await wait(1200)
      return out
    }, CARD, BELOW)) as Frame[]

    assert.ok(frames.length > 30, `expected a full sampling window, got ${frames.length} frames`)
    const mounted = frames.filter((f) => f.h !== null)
    assert.ok(mounted.some((f) => f.leaving), "the card must fade once the board reports the turn")
    assert.equal(frames.at(-1)!.h, null, "the card must be gone at the end")
    const heights = [...new Set(mounted.map((f) => f.h))]
    assert.equal(heights.length, 1, `the card changed height on a turn it did not start: ${JSON.stringify(mounted.filter((f) => f.h !== mounted[0].h).slice(0, 4))}`)
    const moved = mounted.filter((f) => f.belowTop !== mounted[0].belowTop)
    assert.deepEqual(moved.slice(0, 4), [], "the card below moved before the steered card had left")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a running card's turn ends transcript-first: the reply and the Working row never share a frame", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  const REPLY = "Both viewports pass now, and the export no longer buffers."
  type Frame = { t: number; working: boolean; reply: boolean }
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/queue-dissolve-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`[data-queue-card-root="${CARD}"]`)
    await new Promise((r) => setTimeout(r, 600))

    // A card whose thread is working: still in the queue (the board keeps `needsYou`, as it does for a
    // thread with an open question), its turn opened by a landed message.
    await page.evaluate((card: string) => {
      const w = window as unknown as {
        __patchThread: (slug: string, patch: Record<string, unknown>) => void
        __pushMessages: (slug: string, messages: Record<string, unknown>[]) => void
      }
      const now = new Date().toISOString()
      w.__patchThread(card, { runtime: "running", lastUserAt: now, lastActivityAt: now })
      w.__pushMessages(card, [{ sourceId: `${card}-u2`, role: "user", text: "Run the narrow viewport pass too.", tools: [], parts: [], at: now }])
    }, CARD)
    await page.waitForSelector(`[data-queue-card-root="${CARD}"] [data-working-indicator]`, { timeout: 5_000 })
    await new Promise((r) => setTimeout(r, 300))

    const frames = (await page.evaluate(async (card: string, reply: string) => {
      const w = window as unknown as {
        __patchThread: (slug: string, patch: Record<string, unknown>) => void
        __pushMessages: (slug: string, messages: Record<string, unknown>[]) => void
      }
      const out: { t: number; working: boolean; reply: boolean }[] = []
      const t0 = performance.now()
      const tick = () => {
        const root = document.querySelector<HTMLElement>(`[data-queue-card-root="${card}"]`)
        out.push({ t: +(performance.now() - t0).toFixed(1), working: !!root?.querySelector("[data-working-indicator]"), reply: !!root?.innerText.includes(reply.slice(0, 30)) })
        if (performance.now() - t0 < 900) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      await wait(100)
      // The transcript first: the final message and the rest boundary that closes the turn…
      const at = new Date().toISOString()
      w.__pushMessages(card, [
        { sourceId: `${card}-a2`, role: "assistant", text: reply, tools: [], parts: [{ kind: "text", text: reply }], at },
        { sourceId: `${card}-rest2`, role: "assistant", kind: "event", boundary: "rest", text: "Agent rested", tools: [], parts: [], at },
      ])
      await wait(80)
      // …and then the board's rest.
      w.__patchThread(card, { runtime: "turn-idle", lastAssistantAt: at, lastActivityAt: at })
      await wait(900)
      return out
    }, CARD, REPLY)) as Frame[]

    assert.ok(frames.length > 30, `expected a full sampling window, got ${frames.length} frames`)
    assert.equal(frames[0].working && !frames[0].reply, true, "the card must start on the running turn")
    assert.equal(frames.at(-1)!.reply && !frames.at(-1)!.working, true, "the card must end on the reply, at rest")
    const both = frames.filter((f) => f.working && f.reply)
    assert.deepEqual(both.slice(0, 6), [], "the finished reply was drawn with the Working row under it")
    const neither = frames.filter((f) => !f.working && !f.reply)
    assert.deepEqual(neither.slice(0, 6), [], "the Working row left before the reply arrived")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
