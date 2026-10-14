import assert from "node:assert/strict"
import test from "node:test"

// BOTH PAGE SHELLS FOLLOW THE SERVER — the board and the full-screen thread page alike, because what a
// tab does about the server it is talking to is components/PageFrame.tsx's and neither shell's own.
// It was the board's alone until 2026-10-13: a tab on `/thread/<slug>/full` showed no overlay while the
// server was down, kept running the old bundle against the new server after "Update & restart", and,
// cold-loaded there, never raised a desktop notification (the setting was mirrored onto the store by
// App.tsx and by nothing else).
//
// Real server, real broker, real settings RPC; the worker is the scripted one, so nothing signs in:
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<a throwaway git repo> --claude-bin=$PWD/scripts/scripted-claude.mjs
//   FRIZZ_PAGE_FRAME_E2E_URL=http://127.0.0.1:<port> nub run test <this file>
// A dev stack has no launcher, so `/_frizz/control/status` is the one thing answered here rather than
// by the server — which is also what lets the test say "restarting" and name a second build. The poll
// is woken with the app's own wake event (api/supervisorStatus.ts) instead of waiting out its 8s rest
// cadence. The notification half replaces `Notification` and `document.hidden` in the page, since a
// headless tab is always the visible one and has nowhere to show a notification; the event itself is
// the server's own `notify` for a scripted turn that ends, read off the feed's socket for the control.
// The test writes the stack's `notifications` setting and leaves it off.
const baseUrl = process.env.FRIZZ_PAGE_FRAME_E2E_URL

const OVERLAY = '[role="alertdialog"][aria-label="Updating and restarting Frizz"]'
const WAKE = "frizz:supervisor-status-wake"
const ARMED = "frizz:reload-after-update-restart"

type Shell = { name: string; url: string; root: string }
type AppStore = typeof import("../store.ts")
type PageGlobals = {
  frizzPageFrameE2eStore: () => Promise<AppStore>
  frizzPageFrameE2eNotifications: { title: string; tag?: string }[]
  frizzPageFrameE2eMarker?: boolean
}

// One scripted thread at rest, for the full-screen page to show and the board to queue; and the two
// shells' URLs. Shared by both tests.
let prepared: Promise<{ api: ReturnType<typeof import("../../../../scripts/lib/rpc-client.mjs").createRpcClient>; projectSlug: string; shells: Shell[] }> | null = null
function prepare() {
  return (prepared ??= (async () => {
    const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
    const api = createRpcClient(`${baseUrl}/`)
    await api.waitForHealth()
    const { slug } = await api.mutate("dispatch", { prompt: "[script ending=needs paras=6] Follow the server", backend: "claude", model: "haiku", effort: "low" }) as { slug: string }
    let projectSlug = ""
    for (let i = 0; i < 120 && !projectSlug; i++) {
      const board = await api.query("board") as { projectSlug: string; threads: { id: string; runtime: string }[] }
      if (board.threads.find((t) => t.id === slug)?.runtime === "turn-idle") projectSlug = board.projectSlug
      else await new Promise((r) => setTimeout(r, 250))
    }
    assert.ok(projectSlug, "the scripted thread came to rest")
    const board = `${baseUrl}/project/${projectSlug}`
    return {
      api,
      projectSlug,
      shells: [
        { name: "the full-screen thread page", url: `${board}/thread/${slug}/full`, root: "main[data-standalone-thread]" },
        { name: "the board", url: board, root: "#workpane" },
      ],
    }
  })())
}

// The app's own store, by the exact URL the app loaded it from: once vite has hot-updated anything, a
// bare `import("/src/store.ts")` is a second, empty instance (see overlayAccessibility.e2e.test.ts).
function installStoreHandle(): void {
  performance.setResourceTimingBufferSize(100_000)
  ;(globalThis as unknown as PageGlobals).frizzPageFrameE2eStore = () => {
    const loaded = performance.getEntriesByType("resource").map((entry) => entry.name)
      .filter((name) => new URL(name).pathname === "/src/store.ts")
    return import(loaded.at(-1) ?? "/src/store.ts")
  }
}

// A tab nobody is looking at, with permission granted, that records what it would have raised.
function installNotificationStub(): void {
  const raised: { title: string; tag?: string }[] = []
  ;(globalThis as unknown as PageGlobals).frizzPageFrameE2eNotifications = raised
  class RecordedNotification {
    static permission = "granted"
    static requestPermission = async () => "granted"
    onclick: unknown = null
    constructor(title: string, options?: { tag?: string }) { raised.push({ title, tag: options?.tag }) }
    close() {}
  }
  Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: RecordedNotification })
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true })
}

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))

test("the board and the full-screen thread page both follow a restart: the overlay, inert content, and a reload onto a new build", { skip: !baseUrl, timeout: 240_000 }, async () => {
  const { shells } = await prepare()
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    for (const shell of shells) {
      const page = await browser.newPage()
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
      const errors: string[] = []
      page.on("pageerror", (e) => errors.push(String(e)))
      page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })

      // What the supervisor says, and how often it was asked and the document was loaded.
      let answer: { state: "ready" | "restarting"; artifactDigest: string } = { state: "ready", artifactDigest: "build-a" }
      let polls = 0
      let documents = 0
      await page.setRequestInterception(true)
      page.on("request", (r) => {
        if (new URL(r.url()).pathname === "/_frizz/control/status") {
          polls++
          void r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, updateRestart: false, ...answer }) })
          return
        }
        if (r.isNavigationRequest() && r.frame() === page.mainFrame()) documents++
        void r.continue()
      })
      // One more answer, asked for now and applied by the time this resolves.
      const poll = async () => {
        const before = polls
        await page.evaluate((wake) => { window.dispatchEvent(new Event(wake)) }, WAKE)
        for (let i = 0; i < 100 && polls === before; i++) await settle(50)
        assert.ok(polls > before, `${shell.name}: the supervisor was asked again`)
        await settle(150)
      }
      const mark = () => page.evaluate(() => { (globalThis as unknown as PageGlobals).frizzPageFrameE2eMarker = true })
      const marked = () => page.evaluate(() => (globalThis as unknown as PageGlobals).frizzPageFrameE2eMarker === true)
      const box = `${shell.root} textarea`
      // What the eye and the keyboard get: is the overlay drawn over the whole window, does a click on
      // the prompt box land on it, and can the box take focus at all.
      const read = () => page.evaluate((overlaySelector, rootSelector, boxSelector) => {
        const overlay = document.querySelector<HTMLElement>(overlaySelector)
        const root = document.querySelector<HTMLElement>(rootSelector)
        const box = document.querySelector<HTMLTextAreaElement>(boxSelector)
        const rect = overlay?.getBoundingClientRect()
        const at = box?.getBoundingClientRect()
        const hit = at ? document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2) : null
        box?.focus()
        return {
          overlay: overlay !== null,
          coversWindow: !!rect && rect.left === 0 && rect.top === 0 && rect.width === window.innerWidth && rect.height === window.innerHeight,
          overlayInert: overlay?.closest("[inert]") != null,
          contentInert: root?.closest("[inert]") != null,
          clickLandsOnOverlay: !!overlay && !!hit && overlay.contains(hit),
          boxTakesFocus: !!box && document.activeElement === box,
        }
      }, OVERLAY, shell.root, box)
      const atRest = { overlay: false, coversWindow: false, overlayInert: false, contentInert: false, clickLandsOnOverlay: false, boxTakesFocus: true }
      const blocked = { overlay: true, coversWindow: true, overlayInert: false, contentInert: true, clickLandsOnOverlay: true, boxTakesFocus: false }
      const loaded = () => page.waitForSelector(box, { visible: true })
      const restart = async () => {
        answer = { ...answer, state: "restarting" }
        await poll()
        await page.waitForSelector(OVERLAY, { visible: true }).catch((error) => { throw new Error(`${shell.name}: no restart overlay while the supervisor says "restarting"`, { cause: error }) })
      }

      await page.goto(shell.url, { waitUntil: "domcontentloaded" })
      await loaded()
      await mark()
      // Counted from here: the first page a fresh vite serves can load twice on its own account (it
      // reloads the tab once it has optimized the dependencies it discovered).
      const before = documents
      const reloads = () => documents - before

      // THE CONTROL: the same build answering "ready" throughout raises nothing and reloads nothing.
      for (let i = 0; i < 3; i++) await poll()
      assert.deepEqual(await read(), atRest, `${shell.name}: at rest`)
      assert.deepEqual({ marked: await marked(), reloads: reloads() }, { marked: true, reloads: 0 }, `${shell.name}: "ready" from the same build does not reload`)

      // 1. "restarting": the overlay covers the window and stays interactive; the page under it is inert.
      await restart()
      assert.deepEqual(await read(), blocked, `${shell.name}: while restarting`)

      // The same build coming back lifts the block and loads nothing: a reload is for a NEW build.
      answer = { state: "ready", artifactDigest: "build-a" }
      await poll()
      await page.waitForSelector(OVERLAY, { hidden: true })
      assert.deepEqual(await read(), atRest, `${shell.name}: the same build back`)
      assert.deepEqual({ marked: await marked(), reloads: reloads() }, { marked: true, reloads: 0 }, `${shell.name}: the same build coming back does not reload`)

      // 2. "ready" from a DIFFERENT build than the one that served this page: the tab reloads in place.
      await restart()
      answer = { state: "ready", artifactDigest: "build-b" }
      await page.waitForFunction(() => (globalThis as unknown as PageGlobals).frizzPageFrameE2eMarker !== true, { timeout: 15_000 })
        .catch((error) => { throw new Error(`${shell.name}: a "ready" naming another build did not reload the tab`, { cause: error }) })
      await loaded()
      assert.equal(reloads(), 1, `${shell.name}: one reload`)
      assert.equal(page.url(), shell.url, `${shell.name}: reloaded in place`)
      for (let i = 0; i < 2; i++) await poll()
      assert.deepEqual(await read(), atRest, `${shell.name}: after the reload`)
      assert.equal(reloads(), 1, `${shell.name}: the new page takes the new build as its own and does not reload again`)

      // 3. The tab that clicked Update armed a destination (RestartFrizzButton): it is taken on the
      // first believed "ready" after the restart, whatever build answers, and the arming is spent.
      const destination = `${new URL(shell.url).pathname}?after=update`
      await mark()
      await page.evaluate((key, to) => sessionStorage.setItem(key, to), ARMED, destination)
      await restart()
      answer = { state: "ready", artifactDigest: "build-b" }
      await page.waitForFunction(() => (globalThis as unknown as PageGlobals).frizzPageFrameE2eMarker !== true && location.search === "?after=update", { timeout: 15_000 })
        .catch((error) => { throw new Error(`${shell.name}: the armed destination was not taken`, { cause: error }) })
      await loaded()
      assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), ARMED), null, `${shell.name}: the destination is spent`)
      assert.equal(reloads(), 2, `${shell.name}: one load onto the destination`)

      assert.deepEqual(errors, [], `${shell.name}: no page errors`)
      await page.close()
    }
  } finally {
    await browser.close()
  }
})

test("a tab cold-loaded on the board or on the full-screen thread page raises desktop notifications when the setting is on, and none when it is off", { skip: !baseUrl, timeout: 240_000 }, async () => {
  const { api, projectSlug, shells } = await prepare()
  const setNotifications = async (on: boolean) => {
    const settings = await api.query("settingsGet") as Record<string, unknown>
    await api.mutate("settingsSet", { ...settings, notifications: on })
  }
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    for (const shell of shells) {
      const page = await browser.newPage()
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
      await page.evaluateOnNewDocument(installStoreHandle)
      await page.evaluateOnNewDocument(installNotificationStub)
      await page.setRequestInterception(true)
      page.on("request", (r) => {
        if (new URL(r.url()).pathname === "/_frizz/control/status") {
          void r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "ready", updateRestart: false }) })
        } else void r.continue()
      })
      // Every `notify` the server pushed to this tab, whatever the tab then did with it.
      const delivered: string[] = []
      const cdp = await page.createCDPSession()
      await cdp.send("Network.enable")
      cdp.on("Network.webSocketFrameReceived", ({ response }) => {
        const slug = /"type":"notify"[^{}]*"slug":"([^"]+)"|"slug":"([^"]+)"[^{}]*"type":"notify"/.exec(response.payloadData)
        if (slug) delivered.push(slug[1] ?? slug[2])
      })
      const mirrored = () => page.evaluate(async () => (await (globalThis as unknown as PageGlobals).frizzPageFrameE2eStore()).store.notificationsEnabled)
      const raisedFor = (slug: string) => page.evaluate((slug) => (globalThis as unknown as PageGlobals).frizzPageFrameE2eNotifications.map((n) => n.tag).filter((tag) => tag?.endsWith(`/${slug}`)), slug)
      // A turn that ends is a `notify` from the server to every tab on the project.
      const endATurn = async () => {
        const { slug } = await api.mutate("dispatch", { prompt: "[script ending=done paras=1 think=300] End a turn", backend: "claude", model: "haiku", effort: "low" }) as { slug: string }
        for (let i = 0; i < 200 && !delivered.includes(slug); i++) await settle(100)
        assert.ok(delivered.includes(slug), `${shell.name}: the server's notify for ${slug} reached the tab`)
        await settle()
        return slug
      }
      const coldLoad = async () => {
        const settingsRead = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/settingsGet"), { timeout: 20_000 })
          .catch((error) => { throw new Error(`${shell.name}: the page never read the settings`, { cause: error }) })
        await page.goto(shell.url, { waitUntil: "domcontentloaded" })
        await page.waitForSelector(`${shell.root} textarea`, { visible: true })
        await settingsRead
      }

      await setNotifications(true)
      await coldLoad()
      await page.waitForFunction(async () => (await (globalThis as unknown as PageGlobals).frizzPageFrameE2eStore()).store.notificationsEnabled === true, { timeout: 10_000 })
        .catch((error) => { throw new Error(`${shell.name}: the setting is on and the store's mirror of it is still off`, { cause: error }) })
      // The server announces one rest more than once (the turn ending, then the thread entering the
      // queue), and each is raised under the thread's tag, which is what makes a browser show one.
      const loud = await endATurn()
      const raised = await raisedFor(loud)
      assert.ok(raised.length >= 1, `${shell.name}: a notification for the turn that ended`)
      assert.deepEqual([...new Set(raised)], [`/project/${projectSlug}/${loud}`], `${shell.name}: tagged with its project and thread`)

      // THE CONTROL: the same event, delivered to the same tab, raises nothing with the setting off.
      await setNotifications(false)
      await coldLoad()
      await settle()
      assert.equal(await mirrored(), false, `${shell.name}: the mirror follows the setting off`)
      const quiet = await endATurn()
      assert.deepEqual(await raisedFor(quiet), [], `${shell.name}: no notification with the setting off`)

      await page.close()
    }
  } finally {
    await setNotifications(false).catch(() => {})
    await browser.close()
  }
})
