import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { createRpcClient } from "../../../../scripts/lib/rpc-client.mjs"

// A real two-project adhoc-stack, no provider required. The session row is the simulated worker;
// questions are registered and answered through the real RPC. Both variables come from the stack.
const baseUrl = process.env.FRIZZ_QUESTION_NAVIGATION_E2E_URL
const home = process.env.FRIZZ_QUESTION_NAVIGATION_E2E_HOME

test("registered picks survive fullscreen, project switches and reload, then clear only after a successful send", {
  skip: !baseUrl || !home, timeout: 120_000,
}, async () => {
  const api = createRpcClient(baseUrl!)
  const projects = await api.query("projectsList") as Array<{ id: string; slug: string }>
  assert.ok(projects.length >= 2)
  const [a, b] = projects
  const slug = "question-navigation"
  const db = join(home!, ".frizz", "ui.db")
  for (const [i, project] of [a, b].entries()) {
    execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session
      (project_id, slug, session_id, thread_name, spawned_at, title, backend, claude_runtime, model, effort, permission_mode, rested_at)
      VALUES ('${project.id}', '${slug}', 'aabbccdd-0000-4000-9000-00000000000${i}', 'frizz-${slug}',
      '2026-10-09T00:00:00Z', 'Question navigation', 'claude', 'broker', 'opus', 'high', 'default', '2026-10-09T00:01:00Z')`])
  }
  const projectApi = createRpcClient(baseUrl!, a.slug)
  const asked = await projectApi.mutate("ask", { slug, questions: [
    { kind: "question", question: "Land the fix?", options: [
      { label: "Land it", followUps: [{ kind: "multi", question: "Which gates?", options: [{ label: "Tests" }, { label: "Browser" }] }] },
      { label: "Hold it" },
    ] },
    { kind: "question", question: "Where should it ship?", options: [{ label: "Local main" }, { label: "Release" }] },
  ] }) as { registered: Array<{ id: string }> }
  await createRpcClient(baseUrl!, b.slug).mutate("ask", { slug, questions: [
    { kind: "question", question: "Other project", options: [{ label: "Other first" }, { label: "Other second" }] },
  ] })
  const [tree, single] = asked.registered.map((q) => `[data-question-id='${q.id}']`)
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--use-mock-keychain"], protocolTimeout: 30_000 })
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 1100, deviceScaleFactor: 2 })
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }])
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => {
      // adhoc-stack has no launcher control server; throwaway projects have no icon. These 404s
      // are the app's normal fallback, unrelated to answering. The one 500 below is deliberate.
      const url = m.location().url ?? ""
      if (m.type() === "error" && !/\/_frizz\/(control\/status|project-icon)/.test(url)
        && !(/\/rpc\/answerQuestions$/.test(url) && /status of 500/.test(m.text()))) errors.push(`${m.text()} ${url}`)
    })
    await page.goto(`${baseUrl}/project/${a.slug}`, { waitUntil: "networkidle2" })
    await page.waitForSelector(tree)
    const pick = async (card: string, index: number) => {
      await page.$$eval(`${card} [data-question-option]`, (rows, i) => (rows[i].querySelector("button") as HTMLButtonElement).click(), index)
    }
    await pick(tree, 0)
    await page.waitForFunction((sel) => document.querySelectorAll(`${sel} [data-question-option]`).length === 4, {}, tree)
    await pick(tree, 2)
    await pick(tree, 3)
    await pick(single, 1)
    const texts = `${tree} textarea[data-surface='questionAnswer']`
    const handles = await page.$$(texts)
    await handles[1].type("also typecheck")
    const check = async () => {
      await page.waitForFunction((sel) => document.querySelectorAll(`${sel} [data-question-option]`).length === 4, {}, tree)
      assert.deepEqual(await page.$$eval(`${tree} [data-question-option]`, (rows) => rows.map((el) => el.classList.contains("border-selection-border"))), [true, false, true, true])
      assert.deepEqual(await page.$$eval(`${single} [data-question-option]`, (rows) => rows.map((el) => el.classList.contains("border-selection-border"))), [false, true])
      assert.equal(await page.$$eval(texts, (els) => (els[1] as HTMLTextAreaElement).value), "also typecheck")
    }
    await check()
    // The real fullscreen door unmounts the board and creates a fresh answering provider.
    await page.$eval(`[data-expand-thread='${slug}']`, (el) => (el as HTMLAnchorElement).click())
    await page.waitForSelector("main[data-standalone-thread]")
    await check()
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !location.pathname.endsWith("/full"))
    await check()
    // Client-side project switches remount App. The same thread slug in B must not inherit A's picks.
    const switchProject = async (project: string) => {
      const link = `a[href='/project/${project}']`
      await page.waitForSelector(link)
      await page.$eval(link, (el) => (el as HTMLAnchorElement).click())
      await page.waitForFunction((path) => location.pathname === path, {}, `/project/${project}`)
    }
    // The home button leads to the grid; its project links exercise the SPA switch, not a new document.
    const grid = async () => {
      await page.$eval("a[href='/']", (el) => (el as HTMLAnchorElement).click())
      await page.waitForFunction(() => location.pathname === "/")
    }
    await grid()
    await switchProject(b.slug)
    await page.waitForSelector("[data-question-option]")
    assert.equal(await page.$$eval("[data-question-option]", (rows) => rows.some((el) => el.classList.contains("border-selection-border"))), false)
    await grid()
    await switchProject(a.slug)
    await check()
    await page.reload({ waitUntil: "networkidle2" })
    await check()
    if (process.env.FRIZZ_QUESTION_NAVIGATION_E2E_SHOT) {
      const path = process.env.FRIZZ_QUESTION_NAVIGATION_E2E_SHOT
      await page.screenshot({ path, fullPage: true })
      console.log("Optical spacing", (await promisify(execFile)("nub", ["scripts/ink-gaps.mjs", page.url(),
        `${tree} [data-question-option]:first-child > span, ${tree} [data-question-option]:first-child .md-inline`,
        `--browser=${browser.wsEndpoint()}`, "--w=820", "--h=1100", "--dsf=6", "--wait=300",
      ], { encoding: "utf8" })).stdout)
      console.log("Keycap alignment", await page.$eval(`${tree} [data-question-option]`, (row) => {
        const baseline = (element: Element) => {
          const node = [...element.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())!
          const wrap = document.createElement("span"), probe = document.createElement("span")
          node.parentNode!.insertBefore(wrap, node); wrap.appendChild(node)
          probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0"
          wrap.appendChild(probe)
          const y = probe.getBoundingClientRect().bottom
          probe.remove(); wrap.parentNode!.insertBefore(node, wrap); wrap.remove()
          return y
        }
        const cap = row.querySelector(":scope > span")!, label = row.querySelector(".md-inline")!
        return { baselineDeltaPx: baseline(cap) - baseline(label), font: getComputedStyle(label).fontFamily }
      }))
      await page.setViewport({ width: 820, height: 1100, deviceScaleFactor: 6 })
      await (await page.$(tree))!.screenshot({ path: path.replace(/\.png$/, "-narrow.png") })
      await page.setViewport({ width: 1200, height: 1100, deviceScaleFactor: 2 })
    }
    // A rejected send keeps staged picks. A successful real answerQuestions clears the cache.
    let reject = true
    await page.setRequestInterception(true)
    page.on("request", (r) => {
      if (reject && /\/rpc\/answerQuestions$/.test(r.url())) {
        reject = false
        void r.respond({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Test rejection" }) })
      } else void r.continue()
    })
    await page.$eval("[data-send-answers]", (el) => (el as HTMLButtonElement).click())
    await page.waitForSelector("[role='alert']")
    await check()
    await page.$eval("[data-send-answers]", (el) => (el as HTMLButtonElement).click())
    await page.waitForFunction(() => {
      const raw = sessionStorage.getItem("frizz-drafts:v1")
      return !raw || !Object.keys(JSON.parse(raw).entries).some((k) => k.includes("question-navigation") && k.endsWith(":picks"))
    })
    const settled = JSON.parse(execFileSync("sqlite3", [db, `SELECT answer FROM thread_question WHERE id = '${asked.registered[0].id}'`], { encoding: "utf8" }))
    assert.deepEqual(settled.chosen, ["Land it"])
    assert.deepEqual(settled.followUps[0].chosen, ["Tests", "Browser"])
    assert.equal(settled.followUps[0].text, "also typecheck")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
