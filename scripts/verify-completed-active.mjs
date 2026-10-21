// Anonymous reproduction of a previous done handoff leaking its checkmark into Running while a
// follow-up is still in the delivery ledger. Exercises the real tailer, board, SSE and sidebar.
// nub scripts/verify-completed-active.mjs <evidence-dir> [before|after]
import assert from "node:assert/strict"
import { spawn, execFile, execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import puppeteer from "puppeteer"
import { createRpcClient } from "./lib/rpc-client.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const out = resolve(process.argv[2])
const phase = process.argv[3] ?? "after"
assert.ok(phase === "before" || phase === "after")
mkdirSync(out, { recursive: true })
const fixture = mkdtempSync(join(tmpdir(), "anonymous-rail-"))
const project = join(fixture, "Anonymous examples")
mkdirSync(project)
execFileSync("git", ["init", "-q", project])
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FRIZZ_") && key !== "CODEX_HOME"))
// No provider is dispatched: only the simulated transcript is under test.
const stack = spawn(process.execPath, [join(root, "scripts/adhoc-stack.mjs"), "--port=45983", "--claude-bin=/usr/bin/true", `--project=${project}`], {
  cwd: root, env: { ...env, FRIZZ_RUNTIMES: "path" }, stdio: ["ignore", "pipe", "pipe"],
})
let logs = ""
stack.stderr.on("data", (s) => { logs += s })
const stopped = new Promise((resolve) => stack.once("exit", resolve))
let browser
try {
  const info = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`stack readiness timed out: ${logs}`)), 60_000)
    let lines = ""
    stack.stdout.on("data", (chunk) => {
      lines += chunk
      for (const line of lines.split("\n")) {
        try {
          const parsed = JSON.parse(line)
          if (parsed.url && parsed.home) { clearTimeout(timeout); resolve(parsed); return }
        } catch {}
      }
    })
    stack.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`stack exited ${code}: ${logs}`)) })
    stack.once("error", reject)
  })
  const api = createRpcClient(info.url, info.slug)
  const db = new DatabaseSync(join(info.home, ".frizz/ui.db"))
  const sessions = join(info.home, ".codex/sessions/2026/10/21")
  mkdirSync(sessions, { recursive: true })
  const now = Date.now()
  const at = (minutes) => new Date(now - minutes * 60_000).toISOString()
  const fence = "```done\n- **Finished** the anonymous example.\n```"
  for (const [index, slug, title, state] of [
    [1, "finished-example", "Completed example", "done"],
    [2, "pending-follow-up", "Follow-up awaiting delivery", "enqueued"],
    [3, "working-example", "Working example", "running"],
  ]) {
    const id = `019842aa-0000-4000-9000-00000000000${index}`
    const event = (timestamp, payload) => ({ timestamp, type: "event_msg", payload })
    const records = [
      { timestamp: at(10), type: "session_meta", payload: { id, cwd: project } },
      { timestamp: at(10), type: "turn_context", payload: { model: "gpt-5-codex", effort: "high" } },
      event(at(10), { type: "user_message", message: "Complete the anonymous example." }),
      event(at(10), { type: "task_started" }),
      ...(state === "running" ? [] : [
        event(at(3), { type: "agent_message", message: fence, phase: "final_answer" }),
        event(at(3), { type: "task_complete", last_agent_message: fence }),
      ]),
    ]
    writeFileSync(join(sessions, `rollout-2026-10-21T10-00-00-${id}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
    const ledger = state === "enqueued" ? JSON.stringify([{ id: "anonymous-send", text: "Continue with another example.", state, at: at(2), updatedAt: at(2) }]) : null
    db.prepare(`INSERT INTO session (project_id, slug, session_id, agent_session_id, thread_name, spawned_at, title,
      backend, codex_runtime, model, effort, permission_mode, rested_at, delivery_ledger)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'codex', 'app-server', 'gpt-5-codex', 'high', 'default', ?, ?)`)
      .run(info.launcher.id, slug, id, id, `frizz-${slug}`, at(10), title, state === "running" ? null : at(3), ledger)
  }
  db.close()
  const deadline = Date.now() + 30_000
  let board
  do {
    board = await api.query("board")
    if (board.threads.length === 3 && board.threads.find((t) => t.id === "pending-follow-up")?.lastFence?.kind === "done") break
    await new Promise((resolve) => setTimeout(resolve, 200))
  } while (Date.now() < deadline)
  const pending = board.threads.find((t) => t.id === "pending-follow-up")
  assert.equal(pending?.runtime, "turn-idle")
  assert.equal(pending?.needsYou, false)
  assert.ok(!pending?.deliveryInFlight, "control: the short delivery spinner has expired")
  browser = await puppeteer.launch({
    headless: true, protocolTimeout: 30_000,
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    args: ["--no-sandbox", "--use-mock-keychain", "--password-store=basic"],
  })
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(String(error)))
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${message.text()} ${message.location().url ?? ""}`) })
  await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 2 })
  await page.goto(info.url, { waitUntil: "networkidle2" })
  const selector = '[data-sidebar-item="pending-follow-up"] [data-rail-glyph]'
  await page.waitForSelector(selector)
  const mark = await page.$eval(selector, (el) => el.dataset.railGlyph)
  assert.equal(mark, phase === "before" ? "done" : "rest")
  assert.equal(await page.$eval('[data-sidebar-item="finished-example"] [data-rail-glyph]', (el) => el.dataset.railGlyph), "done")
  assert.equal(await page.$eval('[data-sidebar-item="working-example"] [data-rail-glyph]', (el) => el.dataset.railGlyph), "working")
  await page.screenshot({ path: join(out, `${phase}-desktop.png`) })
  const rail = await page.$("aside")
  await rail.screenshot({ path: join(out, `${phase}-rail.png`) })
  if (phase === "after") {
    const row = '[data-sidebar-item="pending-follow-up"]'
    const marks = `${row} [data-rail-glyph],${row} button > span:nth-of-type(2) > span > span`
    const measurement = await promisify(execFile)(process.execPath, [join(root, "scripts/ink-gaps.mjs"), info.url, marks,
      `--browser=${browser.wsEndpoint()}`, "--w=1280", "--h=850", "--dsf=6", "--wait=300"], { encoding: "utf8" })
    writeFileSync(join(out, "optical-gaps.json"), measurement.stdout)
    const vertical = await page.$eval(row, (el) => {
      const mark = el.querySelector("[data-rail-glyph]")
      const text = el.querySelector("button > span:nth-of-type(2) > span > span")
      const node = text.querySelector("span")?.firstChild ?? text.firstChild
      const holder = document.createElement("span")
      node.parentNode.insertBefore(holder, node)
      holder.appendChild(node)
      const probe = document.createElement("span")
      probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0"
      holder.appendChild(probe)
      const baseline = probe.getBoundingClientRect().bottom
      const cs = getComputedStyle(holder)
      const canvas = document.createElement("canvas").getContext("2d")
      canvas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      const cap = canvas.measureText("H").actualBoundingBoxAscent
      const rect = mark.getBoundingClientRect()
      probe.remove()
      holder.parentNode.insertBefore(node, holder)
      holder.remove()
      return { font: canvas.font, sans: document.documentElement.dataset.font, capCenter: baseline - cap / 2,
        frameCenter: (rect.top + rect.bottom) / 2, offset: baseline - cap / 2 - (rect.top + rect.bottom) / 2 }
    })
    writeFileSync(join(out, "optical-vertical.json"), JSON.stringify(vertical, null, 2))
    await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 6 })
    await (await page.$(row)).screenshot({ path: join(out, "after-row-detail.png") })
  }
  await page.setViewport({ width: 420, height: 880, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await page.waitForSelector(`[data-mobile-thread-row="pending-follow-up"] [data-mobile-thread-indicator="${mark}"]`)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no narrow-screen overflow")
  await page.screenshot({ path: join(out, `${phase}-narrow.png`) })
  if (phase === "after") {
    // Observe the send landing and the next turn completing through the real tailer, not a forced
    // needsYou update. The thread must regain both its card and checkmark, then archive normally.
    const timestamp = new Date().toISOString()
    const records = [
      { type: "user_message", message: "Continue with another example." },
      { type: "task_started" },
      { type: "agent_message", message: fence, phase: "final_answer" },
      { type: "task_complete", last_agent_message: fence },
    ].map((payload) => JSON.stringify({ timestamp, type: "event_msg", payload }))
    appendFileSync(join(sessions, "rollout-2026-10-21T10-00-00-019842aa-0000-4000-9000-000000000002.jsonl"), records.join("\n") + "\n")
    await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 2 })
    await page.waitForSelector('[data-sidebar-item="pending-follow-up"] [data-rail-glyph="done"]')
    await page.waitForSelector('[data-sidebar-item="pending-follow-up"] [data-rail-rested-age]')
    assert.equal((await api.query("board")).threads.find((t) => t.id === "pending-follow-up")?.needsYou, true)
    await (await page.$("aside")).screenshot({ path: join(out, "after-completed-rail.png") })
    await api.mutate("setThreadState", { slug: "pending-follow-up", state: "archived" })
    assert.equal((await api.query("board")).threads.find((t) => t.id === "pending-follow-up")?.state, "archived")
  }
  writeFileSync(join(out, `${phase}.json`), JSON.stringify({ phase, mark, errors, board: board.threads.map(({ id, runtime, needsYou, deliveryInFlight }) => ({ id, runtime, needsYou, deliveryInFlight })) }, null, 2))
  console.log(JSON.stringify({ phase, mark, errors, evidence: out }))
  // adhoc-stack has no launcher supervisor; this optional probe returns 404 in every source fixture.
  assert.deepEqual(errors.filter((error) => !error.endsWith("/_frizz/control/status") || !error.includes("404")), [], "no unexpected console or page errors")
} finally {
  if (browser) await browser.close()
  stack.kill("SIGTERM")
  await stopped
  rmSync(fixture, { recursive: true, force: true })
  console.log("Owned browser and disposable stack stopped")
}
