// THE LAYOUT TIMELINE — every distinct arrangement a thread page paints around one moment, with the event
// that committed each, on one clock. Built to answer "why does this jump around?" (maintainer 2026-10-13,
// over a one-second recording of pressing Done: "Look at all the layout shift that happens in this
// clip … figure out whatever it takes to gauge why").
//
// The ideal around any send or any rest is ONE geometry change: before → after. Every extra state is a
// defect with a cause, and this prints the cause's neighbourhood: each `■` line is a distinct visible
// layout of the transcript (row tops and heights in the scroller, the scroll offset, Jump to latest) and
// each `⟵` line is what arrived in between — a board delta (with the thread's runtime), a transcript push
// (its last three messages: role/kind/queued/deliveryState), an RPC, a layout-shift entry. The final line
// counts the GEOMETRY states: label-only changes (the Working clock ticking) and opacity (a ghost bubble
// landing) are not layout and do not count.
//
// It records three things on the page's own clock, 0 = the action:
//   · every rAF frame's visible `[data-transcript-row-key]` rows inside `[data-drawer-transcript-scroll]`;
//   · every inbound WebSocket frame for the thread and every non-board RPC (a WebSocket/fetch shim
//     installed before the app loads);
//   · PAINTED frames through the CDP screencast into `<out>/frames/NNN_±MMMMMms.jpg`. DOM samples show
//     what the DOM held, not what was painted; when a state is in doubt, look at the frames.
//
// Usage — boot a stack first (.agents/skills/frizz-stack; `--creds` for a real worker), get a thread to
// the state you want (a real Haiku worker resting on the ending you care about is the honest fixture:
// `api.mutate("dispatch", { prompt, backend: "claude", model: "haiku", effort: "low" })`), then:
//
//   nub scripts/layout-timeline.mjs --url=http://127.0.0.1:PORT/project/<p> --slug=<thread>
//     [--action=send|steps|none]   send: type --message and press Send (default)
//                                  steps: tick an awaiting card's "I have completed this" box, then Send
//                                  none: act on nothing — open the page and record (e.g. a turn coming
//                                        to rest; start it while the worker is still running)
//     [--message=text] [--ms=9000] [--out=/abs/dir] [--w=1400] [--h=900]
//
// The page is `/thread/<slug>/full`; the drawer draws the same virtualized transcript. The queue page's
// cards are a different surface (TodosView) and are not sampled here.
//
// Measured with it, 2026-10-13 (real Haiku workers, before → after the fixes it found): a send from a
// rest and the reply that ends its turn went from 4 geometry changes to 2.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { launchHeadless } from "./lib/headless-browser.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
  const s = a.slice(2)
  const i = s.indexOf("=")
  return i < 0 ? [s, "1"] : [s.slice(0, i), s.slice(i + 1)]
}))
const { url, slug } = flags
if (!url || !slug) {
  console.error("usage: nub scripts/layout-timeline.mjs --url=http://127.0.0.1:PORT/project/<p> --slug=<thread> [--action=send|steps|none] [--message=…] [--ms=9000] [--out=…]")
  process.exit(1)
}
const action = flags.action ?? "send"
const message = flags.message ?? (action === "steps" ? "" : "Thanks. One more thing: summarise it in one sentence.")
const ms = Number(flags.ms ?? 9000)
const outDir = flags.out ?? join(tmpdir(), `layout-timeline-${slug}-${Date.now()}`)
mkdirSync(join(outDir, "frames"), { recursive: true })
const sleep = (n) => new Promise((r) => setTimeout(r, n))

const browser = await launchHeadless()
const errors = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: Number(flags.w ?? 1400), height: Number(flags.h ?? 900), deviceScaleFactor: 1 })
  page.on("pageerror", (e) => errors.push(String(e)))
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)) })
  await page.evaluateOnNewDocument((slug) => {
    window.__log = []
    const log = (e) => window.__log.push({ t: performance.now(), ...e })
    window.__mark = log
    const Socket = window.WebSocket
    window.WebSocket = class extends Socket {
      constructor(...args) {
        super(...args)
        // Registered before the app's own handler, so the time is the frame's arrival.
        this.addEventListener("message", (e) => {
          const raw = typeof e.data === "string" ? e.data : ""
          let m
          try { m = JSON.parse(raw) } catch { return }
          if (m.t === "hb") return
          if (m.t === "transcript") {
            if (m.slug !== slug) return
            const tail = (m.messages ?? []).slice(-3).map((x) => `${x.role}${x.kind ? "/" + x.kind : ""}${x.queued ? "/Q" : ""}${x.deliveryState ? "/" + x.deliveryState : ""}:${String(x.text ?? "").replace(/\s+/g, " ").slice(0, 24)}`)
            log({ ev: "ws-transcript", n: m.messages?.length, tail })
          } else if (m.t === "event") {
            if (m.event?.type === "vite") return
            const i = raw.indexOf(`"${slug}"`)
            if (i < 0) return
            // The thread's own row in the delta: its fields follow its id.
            const near = raw.slice(i, i + 6000)
            const pick = (k) => new RegExp(`"${k}":("[^"]*"|true|false|null|\\d+)`).exec(near)?.[1]
            log({ ev: `ws-${m.event?.type ?? "event"}`, runtime: pick("runtime"), needsYou: pick("needsYou"), deliveryInFlight: pick("deliveryInFlight") })
          }
        })
      }
    }
    const fetchOriginal = window.fetch
    window.fetch = async (...args) => {
      const rpc = /\/rpc\/(\w+)/.exec(String(args[0]?.url ?? args[0]))?.[1]
      const quiet = !rpc || rpc === "board"
      if (!quiet) log({ ev: "rpc>", rpc })
      const response = await fetchOriginal(...args)
      if (!quiet) log({ ev: "rpc<", rpc, status: response.status })
      return response
    }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          log({ ev: "layout-shift", value: Math.round(e.value * 10000) / 10000, sources: (e.sources ?? []).map((s) => `${s.node?.closest?.("[data-transcript-row-key]")?.dataset.transcriptRowKey?.slice(0, 24) ?? s.node?.nodeName ?? "?"} ${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)}`) })
        }
      }).observe({ type: "layout-shift" })
    } catch {}
  }, slug)

  await page.goto(`${url.replace(/\/$/, "")}/thread/${slug}/full`, { waitUntil: "networkidle2", timeout: 30_000 })
  await page.waitForSelector("[data-drawer-transcript-scroll] [data-transcript-row-key]", { timeout: 20_000 })
  await sleep(2500)

  // Stage the input without sending it.
  if (action === "steps") {
    const ticked = await page.evaluate(() => {
      const box = document.querySelector("[data-steps-complete] button[role=checkbox]")
      box?.click()
      return Boolean(box)
    })
    if (!ticked) throw new Error("no steps checkbox on the page — is the thread resting on an awaiting card with steps?")
    await sleep(300)
  }
  if (action !== "none" && message) {
    const box = await page.$("[data-composer-box] textarea")
    if (!box) throw new Error("no prompt box on the page")
    await box.click()
    await page.keyboard.type(message, { delay: 2 })
  }
  await sleep(400)

  await page.evaluate((ms) => {
    window.__frames = []
    const t0 = performance.now()
    const sample = () => {
      const scroller = document.querySelector("[data-drawer-transcript-scroll]")
      if (scroller) {
        const pane = scroller.getBoundingClientRect()
        const rows = [...scroller.querySelectorAll("[data-transcript-row-key]")].map((el) => {
          const b = el.getBoundingClientRect()
          if (b.bottom < pane.top || b.top > pane.bottom || b.height === 0) return null
          const bubble = el.querySelector(".bg-user-bubble")
          const opacity = bubble ? getComputedStyle(bubble).opacity : "1"
          return { k: el.dataset.transcriptRowKey, y: Math.round(b.top - pane.top), h: Math.round(b.height), l: (el.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 34), op: opacity === "1" ? undefined : opacity }
        }).filter(Boolean)
        const jump = [...document.querySelectorAll("button")].some((b) => /Jump to latest/.test(b.textContent ?? "") && b.getBoundingClientRect().height > 0 && getComputedStyle(b).visibility !== "hidden" && getComputedStyle(b).opacity !== "0")
        window.__frames.push({ t: performance.now(), st: Math.round(scroller.scrollTop), max: Math.round(scroller.scrollHeight - scroller.clientHeight), rows, jump })
      }
      if (performance.now() - t0 < ms + 1000) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }, ms)

  const cdp = await page.createCDPSession()
  const painted = []
  cdp.on("Page.screencastFrame", (f) => {
    painted.push({ wall: Date.now(), data: f.data })
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 75, everyNthFrame: 1 })
  await sleep(300)
  const clock = await page.evaluate(() => ({ perf: performance.now(), wall: performance.timeOrigin + performance.now() }))
  const zero = await page.evaluate(() => { window.__mark({ ev: "ACTION" }); return performance.now() })
  if (action !== "none") {
    const send = await page.evaluateHandle(() => [...document.querySelectorAll("[data-composer-box] button[aria-label=Send]")].find((b) => !b.disabled && b.getBoundingClientRect().height > 0) ?? null)
    const element = send.asElement()
    if (!element) throw new Error("no enabled Send in the prompt box")
    const box = await element.boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  }
  await sleep(ms)
  await cdp.send("Page.stopScreencast")
  const { log, frames } = await page.evaluate(() => ({ log: window.__log, frames: window.__frames }))
  painted.forEach((f, i) => {
    const t = Math.round(f.wall - clock.wall + clock.perf - zero)
    writeFileSync(join(outDir, "frames", `${String(i).padStart(3, "0")}_${t < 0 ? "-" : "+"}${String(Math.abs(t)).padStart(5, "0")}ms.jpg`), Buffer.from(f.data, "base64"))
  })
  writeFileSync(join(outDir, "raw.json"), JSON.stringify({ zero, log, frames }))

  const at = (t) => `${String(Math.round(t - zero)).padStart(6)}ms`
  const lines = log.filter((e) => e.t >= zero - 50).map((e) => ({ t: e.t, text: `${at(e.t)}  ⟵ ${e.ev}${e.rpc ? ` ${e.rpc}` : ""}${e.status ? ` ${e.status}` : ""}${e.runtime ? ` runtime=${e.runtime}` : ""}${e.needsYou ? ` needsYou=${e.needsYou}` : ""}${e.deliveryInFlight ? ` deliveryInFlight=${e.deliveryInFlight}` : ""}${e.n ? ` n=${e.n} tail=${JSON.stringify(e.tail)}` : ""}${e.value !== undefined ? ` ${e.value} ${JSON.stringify(e.sources)}` : ""}` }))
  // A geometry state changes only with the scroll offset, Jump to latest, or a row's top or height —
  // never with a label or an opacity.
  const geometry = (f) => JSON.stringify([f.st, f.max, f.jump, f.rows.map((r) => [r.y, r.h])])
  let before = frames.filter((f) => f.t < zero).pop()
  let states = 0
  let previous = before ? geometry(before) : null
  if (before) lines.push({ t: before.t, text: `${at(before.t)}  ■ BEFORE st=${before.st}/${before.max}\n${before.rows.map((r) => `            [${r.y}+${r.h}${r.op ? ` op${r.op}` : ""}] ${r.l}`).join("\n")}` })
  for (const f of frames) {
    if (f.t < zero) continue
    const g = geometry(f)
    if (g === previous) continue
    previous = g
    states++
    lines.push({ t: f.t, text: `${at(f.t)}  ■ state ${states} st=${f.st}/${f.max}${f.jump ? " JUMP-TO-LATEST" : ""}\n${f.rows.map((r) => `            ${r.k.startsWith("queued") ? "Q" : " "}[${r.y}+${r.h}${r.op ? ` op${r.op}` : ""}] ${r.l}`).join("\n")}` })
  }
  lines.sort((a, b) => a.t - b.t)
  const report = `${lines.map((l) => l.text).join("\n")}\n\ngeometry states after the action: ${states}\npainted frames: ${painted.length} in ${outDir}/frames\npage errors: ${JSON.stringify(errors.filter((e) => !e.includes("404")).slice(0, 4))}\n`
  writeFileSync(join(outDir, "timeline.txt"), report)
  console.log(report)
} finally {
  await browser.close()
}
