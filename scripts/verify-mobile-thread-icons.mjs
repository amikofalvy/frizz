// PII-free, real-stack mobile/desktop indicator capture. No provider or personal HOME is used.
// nub scripts/verify-mobile-thread-icons.mjs <output-dir> [before|after]
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawn, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import { resolve, join } from "node:path"
import puppeteer from "puppeteer"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"
import { createRpcClient } from "./lib/rpc-client.mjs"

assert.ok(process.argv[2], "usage: verify-mobile-thread-icons.mjs <output-dir> [before|after]")
const output = resolve(process.argv[2])
const phase = process.argv[3] ?? "after"
assert.ok(phase === "before" || phase === "after", "phase must be before or after")
mkdirSync(output, { recursive: true })
const projectHome = mkdtempSync(join(tmpdir(), "thread-demo-"))
const project = join(projectHome, "thread-demo")
mkdirSync(project)
execFileSync("git", ["init", "-q", project])
const portProbe = createServer()
await new Promise((r) => portProbe.listen(0, "127.0.0.1", r))
const port = portProbe.address().port
await new Promise((r) => portProbe.close(r))
let browser
let recorder
let stack
let stackExit
let log = ""
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  stack = spawn("nub", ["scripts/adhoc-stack.mjs", `--port=${port}`, `--project=${project}`], { stdio: ["ignore", "pipe", "pipe"] })
  stackExit = new Promise((r) => stack.once("exit", r))
  stack.stdout.on("data", (s) => { log += s })
  stack.stderr.on("data", (s) => { log += s })
  let info
  const deadline = Date.now() + 90_000
  while (!info) {
    assert.equal(stack.exitCode, null, log)
    assert.ok(Date.now() < deadline, log)
    info = log.split("\n").map((line) => { try { return JSON.parse(line) } catch { return null } }).find((v) => v?.launcher)
    if (!info) await delay(200)
  }
  const api = createRpcClient(info.url, info.launcher.id)
  const sandbox = resolveSandboxDb(info.home)
  const { cols, vals } = sessionProjectColumns(sandbox)
  const transcripts = join(info.home, ".claude", "projects", project.replace(/[/.]/g, "-"))
  mkdirSync(transcripts, { recursive: true })
  const now = Date.now()
  const cases = [
    ["rest", "Review the sample notes", "The sample notes are ready to review.", "end_turn"],
    ["done", "Add a sample checklist", "```done\n- Added the sample checklist.\n```", "end_turn"],
    ["ask", "Choose a sample colour", "Which sample colour should the demo use?", "ask"],
    ["working", "Build the sample page", "Building the sample page", "tool_use"],
    ["snoozed", "Review the demo tomorrow", "The demo is ready for another review.", "end_turn"],
    ["archived", "Finish the demo setup", "```done\n- Finished the demo setup.\n```", "end_turn"],
  ]
  for (const [i, [slug, title, text, stop]] of cases.entries()) {
    const sessionId = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`
    const at = new Date(now - (i + 1) * 60_000).toISOString()
    // Simulated worker, like the existing transcript seeds: this harness supplies its live PID.
    // No provider is started; the real tailer and board still derive all UI state from the JSONL.
    const brokerDir = join(sandbox.stateDir, "claude-broker")
    mkdirSync(brokerDir, { recursive: true })
    const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
    writeFileSync(join(brokerDir, `${key}.json`), JSON.stringify({ sessionId, daemonPid: process.pid, socketPath: join(brokerDir, `${key}.sock`) }))
    const content = stop === "tool_use"
      ? [{ type: "tool_use", id: "tool-demo", name: "Bash", input: { command: "echo demo", description: text } }]
      : stop === "ask"
        ? [{ type: "tool_use", id: "ask-demo", name: "AskUserQuestion", input: { questions: [{ question: text, header: "Colour", options: [{ label: "Blue", description: "A blue sample" }, { label: "Green", description: "A green sample" }], multiSelect: false }] } }]
        : [{ type: "text", text }]
    writeFileSync(join(transcripts, `${sessionId}.jsonl`), [
      { type: "user", timestamp: at, sessionId, message: { role: "user", content: title } },
      { type: "assistant", timestamp: at, sessionId, message: { id: `demo-${i}`, model: "claude-opus-5", role: "assistant", content, stop_reason: stop === "ask" ? "tool_use" : stop } },
    ].map(JSON.stringify).join("\n") + "\n")
    execFileSync("sqlite3", [sandbox.db, `INSERT INTO session (${cols}slug, session_id, thread_name, spawned_at, title, title_auto, backend, model, effort, permission_mode, state, unread, exited, archived, claude_runtime)
      VALUES (${vals}'${slug}', '${sessionId}', 'frizz-${slug}', '${at}', '${title}', 0, 'claude', 'opus', 'high', 'auto', '${slug === "archived" ? "archived" : "open"}', 0, 0, ${slug === "archived" ? 1 : 0}, 'broker')`])
  }
  for (let i = 0; i < 100; i++) {
    const board = await api.query("board")
    if (board.threads?.length === cases.length && board.threads.some((t) => t.id === "snoozed" && t.runtime === "turn-idle")) break
    assert.ok(i < 99, "seeded sessions must reach the board")
    await delay(200)
  }
  await api.mutate("setThreadSnooze", { slug: "snoozed", sessionId: "00000000-0000-4000-8000-000000000005", until: new Date(now + 86400_000).toISOString(), prompt: null })
  const localChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? (existsSync(localChrome) ? localChrome : undefined), args: ["--no-sandbox", "--use-mock-keychain"], timeout: 90_000, protocolTimeout: 30_000 })
  const page = await browser.newPage()
  const errors = []
  const expectedErrors = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() !== "error") return
    // adhoc-stack has no launcher control plane. The same optional status probe 404s before the fix.
    const list = m.location().url === `http://127.0.0.1:${port}/_frizz/control/status` ? expectedErrors : errors
    list.push(`${m.text()} ${m.location().url}`)
  })
  page.on("response", (r) => { if (r.status() >= 400) console.log("HTTP error", r.status(), r.url()) })
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await page.goto(info.url, { waitUntil: "networkidle2" })
  await page.waitForSelector('[data-mobile-thread-row="working"]', { timeout: 30_000 })
  const threadStates = async () => (await api.query("board")).threads?.map((t) => ({ id: t.id, runtime: t.runtime, snoozedUntil: t.snoozedUntil, state: t.state }))
  console.log(JSON.stringify(await threadStates()))
  const selectTab = async (tab, row) => {
    await page.tap(`[data-mobile-tab="${tab}"]`)
    try {
      await page.waitForSelector(`[data-mobile-tab="${tab}"][aria-selected="true"]`)
      await page.waitForSelector(`[data-mobile-thread-row="${row}"]`)
    } catch (error) {
      console.log("Tab failure", JSON.stringify(await threadStates()), await page.evaluate(() => document.body.innerText))
      await page.screenshot({ path: join(output, `${phase}-tab-failure.png`) })
      throw error
    }
  }
  await page.screenshot({ path: join(output, `${phase}-mobile.png`) })
  recorder = await page.screencast({ path: join(output, `${phase}-mobile.webm`) })
  await delay(3500)
  await selectTab("snoozed", "snoozed")
  await page.screenshot({ path: join(output, `${phase}-snoozed.png`) })
  await delay(1200)
  await selectTab("done", "archived")
  await delay(1200)
  await selectTab("queue", "working")
  await recorder.stop()
  recorder = undefined
  const mobile = await page.$eval('[data-mobile-thread-row="working"]', (r) => r.innerHTML)
  if (phase === "before") assert.ok(!mobile.includes("<animate"), "negative control: old mobile is static")
  else {
    assert.ok(mobile.includes("<animate"), "running mobile row must spin")
    const offset = () => page.$eval('[data-mobile-thread-row="working"] rect[stroke-dasharray]', (r) => getComputedStyle(r).strokeDashoffset)
    const first = await offset()
    await delay(220)
    assert.notEqual(await offset(), first, "Chrome must actually advance the mobile spinner")
    const readings = await page.evaluate(() => [...document.querySelectorAll('[data-mobile-thread-row]')].map((row) => {
      const title = row.children[1].firstElementChild.firstElementChild
      const node = [...title.childNodes].find((n) => n.nodeType === 3)
      const span = document.createElement('span')
      node.parentNode.insertBefore(span, node)
      span.appendChild(node)
      const probe = document.createElement('span')
      probe.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0'
      span.appendChild(probe)
      const baseline = probe.getBoundingClientRect().bottom
      const cs = getComputedStyle(span)
      const canvas = document.createElement('canvas').getContext('2d')
      canvas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      const cap = canvas.measureText('H').actualBoundingBoxAscent
      const text = canvas.measureText(node.textContent)
      probe.remove()
      span.parentNode.insertBefore(node, span)
      span.remove()
      const mark = row.querySelector('[data-mobile-thread-indicator]')
      const frame = mark.firstElementChild.getBoundingClientRect()
      const tb = title.getBoundingClientRect()
      return { id: row.getAttribute('data-mobile-thread-row'), capOffset: +(baseline - cap / 2 - (frame.top + frame.height / 2)).toFixed(2), textOffset: +(baseline - (text.actualBoundingBoxAscent - text.actualBoundingBoxDescent) / 2 - (frame.top + frame.height / 2)).toFixed(2), boxGap: +(tb.left - frame.right).toFixed(2), frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height }, overflow: row.scrollWidth > row.clientWidth }
    }))
    console.log("Optical readings", JSON.stringify(readings))
    for (const reading of readings) {
      assert.ok(Math.abs(reading.capOffset) < 0.3, `${reading.id}: frame must align to the title cap band`)
      assert.equal(reading.overflow, false)
    }
    writeFileSync(join(output, 'optical-readings.json'), JSON.stringify(readings, null, 2))
    const proc = spawn('nub', ['scripts/ink-gaps.mjs', info.url, '[data-mobile-thread-row="working"] [data-mobile-thread-indicator],[data-mobile-thread-row="working"] > span:nth-child(2) > span:first-child > span:first-child', '--w=390', '--h=844', '--dsf=6', `--browser=${browser.wsEndpoint()}`], { stdio: ['ignore', 'pipe', 'inherit'] })
    let ink = ''
    proc.stdout.on('data', (s) => { ink += s })
    assert.equal(await new Promise((r) => proc.once('exit', r)), 0, 'ink-gap instrument')
    writeFileSync(join(output, 'ink-gaps.json'), ink)
    console.log(ink)
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 6, isMobile: true, hasTouch: true })
    await page.screenshot({ path: join(output, 'after-detail.png'), clip: { x: 12, y: readings[0].frame.y - 10, width: 330, height: readings.at(-1).frame.y - readings[0].frame.y + 40 } })
    await page.setViewport({ width: 320, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await page.screenshot({ path: join(output, 'after-narrow.png') })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no narrow horizontal overflow')
  }
  await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2, isMobile: false, hasTouch: false })
  await page.reload({ waitUntil: "networkidle2" })
  await page.waitForSelector('[data-rail-glyph="working"] animate')
  await page.screenshot({ path: join(output, `${phase}-desktop.png`) })
  assert.deepEqual(errors, [], "no page/console errors")
  console.log(`Captured ${phase}; no unexpected page/console errors; ${expectedErrors.length} known adhoc control-plane 404s`)
} finally {
  await recorder?.stop()
  await browser?.close()
  if (stack?.exitCode === null) { stack.kill("SIGTERM"); await stackExit }
  rmSync(projectHome, { recursive: true, force: true })
  console.log("Owned browser and disposable stack stopped")
}
