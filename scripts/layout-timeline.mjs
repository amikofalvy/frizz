// THE LAYOUT TIMELINE — every distinct arrangement a thread page paints around one moment, with the event
// that committed each, on one clock. Built to answer "why does this jump around?" (maintainer 2026-10-13,
// over a one-second recording of pressing Done: "Look at all the layout shift that happens in this
// clip … figure out whatever it takes to gauge why").
//
// The ideal around any send, steer or rest is ONE geometry change per piece of new content, and no state
// that exists only in between. Every extra state is a defect with a cause, and this prints the cause's
// neighbourhood: each `■` line is a distinct visible layout (row tops and heights in the scroller, the
// scroll offset, Jump to latest, and the page's chrome: footer, prompt box, scroller, row x-extents) and
// each `⟵` line is what arrived in between — a board delta (with the thread's runtime), a transcript push
// (its last messages: role/kind/queued/deliveryState), an RPC, a layout-shift entry. Two things geometry
// ignores by design are tracked beside it, because both are defects when they flash: `◐` lines are opacity
// changes of dimmed bubbles (a send's ghost is 2: it appears dimmed, it lands; more is a flicker, and a
// CSS fade would read as many), and the summary lists every time the live Working row came or went (once
// each per turn). A label-only change — the Working clock ticking — is neither.
//
// It records, on the page's own clock (0 = the action):
//   · every rAF frame's visible `[data-transcript-row-key]` rows inside `[data-drawer-transcript-scroll]`;
//   · every inbound WebSocket frame for the thread and every non-board RPC (a WebSocket/fetch shim
//     installed before the app loads);
//   · PAINTED frames through the CDP screencast into `<out>/frames/NNN_±MMMMMms.jpg`. DOM samples show
//     what the DOM held, not what was painted; when a state is in doubt, look at the frames.
//
// THE WORKER IS `scripts/scripted-claude.mjs`, never a live model: a live Claude on a sandbox stack raises
// a keychain dialog on the maintainer's screen (AGENTS.md § Never put a macOS keychain dialog…), and a
// script's timings can be repeated. Boot a stack with it as the Claude binary, rest a thread on the
// ending you want, then record:
//
//   nub scripts/adhoc-stack.mjs --port=4980 --project=<throwaway repo> --claude-bin=$PWD/scripts/scripted-claude.mjs
//   api.mutate("dispatch", { prompt: "[script ending=steps paras=14] …", backend: "claude" })   // then wait for turn-idle
//   nub scripts/layout-timeline.mjs --url=http://127.0.0.1:4980/project/<p> --slug=<thread>
//     [--action=send|steps|answer|markdone|none]
//          send      type --message into the prompt box and press Send (default)
//          steps     tick an awaiting card's "I have completed this" box, then Send
//          answer    pick a registered question's option (--option=<text>, default the first), then Send
//          markdone  press a ```done card's "Mark as done"
//          none      press nothing
//     [--start=rpc]         at 0, start a turn with a followUp over RPC — a send from ANOTHER tab. Use with
//                           --action=none to watch a turn open, run and rest with nobody at the keyboard
//     [--steers=1500,1900]  ms after 0 at which the page types a steer and presses Send, into the running turn
//     [--message=text] [--ms=9000] [--out=/abs/dir] [--w=1400] [--h=900]
//
// The page is `/thread/<slug>/full`; the drawer draws the same virtualized transcript. The queue page's
// cards are a different surface (TodosView) and are not sampled here.
//
// Measured with it on 2026-10-13, scripted workers, 3+ runs per cell at 1400 and 820 wide, short and tall
// threads: a send from any rest (steps, done, needs_input, bare, a question's answer) paints 2 states; a
// turn opened from another tab paints 2 (it opens, it rests); a steer adds 3; two steers add 5. Before the
// fixes it found, the same send painted 4.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { launchHeadless } from "./lib/headless-browser.mjs"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
  const s = a.slice(2)
  const i = s.indexOf("=")
  return i < 0 ? [s, "1"] : [s.slice(0, i), s.slice(i + 1)]
}))
const { url, slug } = flags
if (!url || !slug) {
  console.error("usage: nub scripts/layout-timeline.mjs --url=http://127.0.0.1:PORT/project/<p> --slug=<thread> [--action=send|steps|answer|markdone|none] [--start=rpc] [--steers=1500,1900] [--message=…] [--ms=9000] [--out=…]")
  process.exit(1)
}
const startRpc = flags.start === "rpc"
const steers = (flags.steers ?? "").split(",").filter(Boolean).map(Number)
const action = flags.action ?? (startRpc || steers.length ? "none" : "send")
const typed = action === "send"
const message = flags.message ?? (typed ? "Thanks. One more thing: summarise it in one sentence." : "")
const ms = Number(flags.ms ?? 9000)
const outDir = flags.out ?? join(tmpdir(), `layout-timeline-${slug}-${Date.now()}`)
mkdirSync(join(outDir, "frames"), { recursive: true })
const sleep = (n) => new Promise((r) => setTimeout(r, n))
const STEER_TEXT = ["Also: mention the word pineapple.", "And end with a one-line summary."]
const api = createRpcClient(`${new URL(url).origin}/`)

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
            const tail = (m.messages ?? []).slice(-4).map((x) => `${x.role}${x.kind ? "/" + x.kind : ""}${x.queued ? "/Q" : ""}${x.deliveryState ? "/" + x.deliveryState : ""}:${String(x.text ?? "").replace(/\s+/g, " ").slice(0, 20)}`)
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
  const click = async (handle, what) => {
    const element = handle.asElement()
    if (!element) throw new Error(`no ${what} on the page`)
    const b = await element.boundingBox()
    await page.mouse.click(b.x + Math.min(40, b.width / 2), b.y + b.height / 2)
  }
  if (action === "answer") {
    await click(await page.evaluateHandle((wanted) => {
      const options = [...document.querySelectorAll("[data-registered-questions] [data-question-grid] > *")]
      return (wanted ? options.find((e) => (e.textContent ?? "").includes(wanted)) : options[0]) ?? null
    }, flags.option ?? ""), "question option")
    await sleep(300)
  }
  const promptBox = async () => {
    const box = await page.$("[data-composer-box] textarea")
    if (!box) throw new Error("no prompt box on the page")
    await box.click()
  }
  if (typed && message) {
    await promptBox()
    await page.keyboard.type(message, { delay: 2 })
  } else if (steers.length) {
    // The first steer is typed ahead, so its click lands exactly at its offset.
    await promptBox()
    await page.keyboard.type(STEER_TEXT[0], { delay: 2 })
  }
  await sleep(400)

  await page.evaluate((ms) => {
    window.__frames = []
    const t0 = performance.now()
    const box4 = (b) => [Math.round(b.top), Math.round(b.height), Math.round(b.left), Math.round(b.width)]
    const sample = () => {
      const scroller = document.querySelector("[data-drawer-transcript-scroll]")
      if (scroller) {
        const pane = scroller.getBoundingClientRect()
        const xs = new Set()
        const rows = [...scroller.querySelectorAll("[data-transcript-row-key]")].map((el) => {
          const b = el.getBoundingClientRect()
          xs.add(`${Math.round(b.left)}+${Math.round(b.width)}`)
          if (b.bottom < pane.top || b.top > pane.bottom || b.height === 0) return null
          // A ghost's dimming may sit on the row or on the bubble: read the effective opacity up the chain.
          let opacity = 1
          for (let n = el.querySelector(".bg-user-bubble") ?? el; n && n !== scroller; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity)
          return { k: el.dataset.transcriptRowKey, y: Math.round(b.top - pane.top), h: Math.round(b.height), l: (el.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 34), live: Boolean(el.querySelector("[data-working-indicator]")) || undefined, op: opacity === 1 ? undefined : Math.round(opacity * 100) / 100 }
        }).filter(Boolean)
        const jump = [...document.querySelectorAll("button")].some((b) => /Jump to latest/.test(b.textContent ?? "") && b.getBoundingClientRect().height > 0 && getComputedStyle(b).visibility !== "hidden" && getComputedStyle(b).opacity !== "0")
        const rect = (selector) => { const el = document.querySelector(selector); return el ? box4(el.getBoundingClientRect()) : null }
        const chrome = { footer: rect("[data-thread-chat-footer]"), box: rect("[data-composer-box]"), scroller: box4(pane), rowsX: [...xs].join(" ") }
        window.__frames.push({ t: performance.now(), st: Math.round(scroller.scrollTop), max: Math.round(scroller.scrollHeight - scroller.clientHeight), rows, jump, chrome })
      }
      if (performance.now() - t0 < ms + 2000) requestAnimationFrame(sample)
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
  const zeroWall = Date.now()
  const pressSend = async () => click(await page.evaluateHandle(() => [...document.querySelectorAll("[data-composer-box] button[aria-label=Send]")].find((b) => !b.disabled && b.getBoundingClientRect().height > 0) ?? null), "enabled Send in the prompt box")

  const pending = []
  if (startRpc) {
    const sessionId = (await api.query("board")).threads.find((t) => t.id === slug)?.sessionId
    pending.push(api.mutate("followUp", { slug, sessionId, message: "Go on: expand on the second point." }).catch((e) => errors.push(`followUp: ${e.message}`)))
  }
  if (action === "markdone") {
    await click(await page.evaluateHandle(() => [...document.querySelectorAll("[data-drawer-transcript-scroll] button")].find((b) => /Mark as done/.test(b.textContent ?? "") && !b.disabled) ?? null), "Mark as done in the transcript")
  } else if (action !== "none") {
    await pressSend()
  }
  for (const [i, at] of steers.entries()) {
    if (i > 0) {
      await sleep(Math.max(0, zeroWall + at - 600 - Date.now()))
      await page.keyboard.type(STEER_TEXT[i % STEER_TEXT.length], { delay: 1 })
    }
    await sleep(Math.max(0, zeroWall + at - Date.now()))
    await page.evaluate((i) => window.__mark({ ev: `STEER${i}` }), i)
    await pressSend()
  }
  await Promise.all(pending)
  await sleep(Math.max(0, zeroWall + ms - Date.now()))
  await cdp.send("Page.stopScreencast")
  const { log, frames } = await page.evaluate(() => ({ log: window.__log, frames: window.__frames }))
  painted.forEach((f, i) => {
    const t = Math.round(f.wall - clock.wall + clock.perf - zero)
    writeFileSync(join(outDir, "frames", `${String(i).padStart(4, "0")}_${t < 0 ? "-" : "+"}${String(Math.abs(t)).padStart(5, "0")}ms.jpg`), Buffer.from(f.data, "base64"))
  })
  writeFileSync(join(outDir, "raw.json"), JSON.stringify({ zero, log, frames }))

  const at = (t) => `${String(Math.round(t - zero)).padStart(6)}ms`
  const lines = log.filter((e) => e.t >= zero - 50).map((e) => ({ t: e.t, text: `${at(e.t)}  ⟵ ${e.ev}${e.rpc ? ` ${e.rpc}` : ""}${e.status ? ` ${e.status}` : ""}${e.runtime ? ` runtime=${e.runtime}` : ""}${e.needsYou ? ` needsYou=${e.needsYou}` : ""}${e.deliveryInFlight ? ` deliveryInFlight=${e.deliveryInFlight}` : ""}${e.n ? ` n=${e.n} tail=${JSON.stringify(e.tail)}` : ""}${e.value !== undefined ? ` ${e.value} ${JSON.stringify(e.sources)}` : ""}` }))
  // A geometry state changes only with the scroll offset, Jump to latest, a row's top or height, or the
  // page's chrome — never with a label or an opacity.
  const geometry = (f) => JSON.stringify([f.st, f.max, f.jump, f.rows.map((r) => [r.y, r.h]), f.chrome])
  // By label, not key: a send's bubble changes key twice on its way in (optimistic, delivery, landed).
  const dimmed = (f) => JSON.stringify(f.rows.filter((r) => r.op !== undefined).map((r) => [r.l.slice(0, 24), r.op]))
  // The page follows its tail, so a live row out of view is a live row gone.
  const working = (f) => f.rows.some((r) => r.live)
  const rowsOf = (f) => f.rows.map((r) => `            ${r.k.startsWith("queued") ? "Q" : " "}[${r.y}+${r.h}${r.op ? ` op${r.op}` : ""}] ${r.l}`).join("\n")
  const before = frames.filter((f) => f.t < zero).pop()
  let states = 0
  const firstSteer = log.find((e) => e.ev === "STEER0")?.t
  let statesBeforeSteer = 0
  let previous = before ? geometry(before) : null
  let previousDimmed = before ? dimmed(before) : null
  let previousWorking = before ? working(before) : null
  const workingFlips = []
  let opacityFlips = 0
  if (before) lines.push({ t: before.t, text: `${at(before.t)}  ■ BEFORE st=${before.st}/${before.max}\n${rowsOf(before)}` })
  for (const f of frames) {
    if (f.t < zero) continue
    if (working(f) !== previousWorking) { previousWorking = working(f); workingFlips.push(`${Math.round(f.t - zero)}ms ${previousWorking ? "on" : "off"}`) }
    if (dimmed(f) !== previousDimmed) { previousDimmed = dimmed(f); opacityFlips++; lines.push({ t: f.t, text: `${at(f.t)}  ◐ opacity ${previousDimmed}` }) }
    const g = geometry(f)
    if (g === previous) continue
    previous = g
    states++
    if (firstSteer !== undefined && f.t < firstSteer) statesBeforeSteer++
    lines.push({ t: f.t, text: `${at(f.t)}  ■ state ${states} st=${f.st}/${f.max}${f.jump ? " JUMP-TO-LATEST" : ""}\n${rowsOf(f)}` })
  }
  lines.sort((a, b) => a.t - b.t)
  const report = `${lines.map((l) => l.text).join("\n")}\n\ngeometry states after the action: ${states}${firstSteer === undefined ? "" : ` (before the first steer: ${statesBeforeSteer}, from it: ${states - statesBeforeSteer})`}\nWorking row: ${workingFlips.join(", ") || "never shown"}\nopacity changes: ${opacityFlips}\npainted frames: ${painted.length} in ${outDir}/frames\npage errors: ${JSON.stringify(errors.filter((e) => !e.includes("404")).slice(0, 4))}\n`
  writeFileSync(join(outDir, "timeline.txt"), report)
  console.log(report)
} finally {
  await browser.close()
}
