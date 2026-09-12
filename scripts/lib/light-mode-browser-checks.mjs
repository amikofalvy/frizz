import assert from "node:assert/strict"

export async function checkThemePreferences({ browser, url, check }) {
  const cases = [
    { name: "Fresh browser follows light OS", preference: null, os: "light", expected: "light" },
    { name: "Fresh browser follows dark OS", preference: null, os: "dark", expected: "dark" },
    { name: "Persisted Light overrides dark OS", preference: "light", os: "dark", expected: "light" },
    { name: "Persisted Dark overrides light OS", preference: "dark", os: "light", expected: "dark" },
    { name: "System follows dark OS", preference: "system", os: "dark", expected: "dark" },
    { name: "Invalid preference follows light OS", preference: "invalid", os: "light", expected: "light" },
    { name: "Denied storage still follows light OS", preference: null, os: "light", expected: "light", deny: true },
    { name: "Missing media-query API resolves Light", preference: null, os: "dark", expected: "light", noMedia: true },
  ]
  for (const scenario of cases) {
    const context = await browser.createBrowserContext()
    try {
      const page = await context.newPage()
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scenario.os }])
      await page.evaluateOnNewDocument(({ preference, deny, noMedia }) => {
        if (preference !== null) localStorage.setItem("frizz-theme", preference)
        if (deny) Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage denied", "SecurityError") } })
        if (noMedia) Object.defineProperty(window, "matchMedia", { value: undefined })
        window.themeFrames = []
        const tick = () => {
          if (document.documentElement) {
            const style = getComputedStyle(document.documentElement)
            const frame = { theme: document.documentElement.dataset.theme, color: style.backgroundColor, scheme: style.colorScheme, chrome: document.querySelector('meta[name="theme-color"]')?.content }
            if (JSON.stringify(frame) !== JSON.stringify(window.themeFrames.at(-1))) window.themeFrames.push(frame)
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }, scenario)
      await page.setRequestInterception(true)
      page.on("request", request => {
        if (request.url().endsWith("/src/main.tsx")) setTimeout(() => request.continue().catch(() => {}), 600)
        else request.continue().catch(() => {})
      })
      await page.goto(url, { waitUntil: "networkidle2" })
      const frames = await page.evaluate(() => window.themeFrames)
      assert.ok(frames.length, scenario.name)
      assert.deepEqual([...new Set(frames.map(frame => frame.theme))], [scenario.expected], `${scenario.name}: ${JSON.stringify(frames)}`)
      assert.deepEqual([...new Set(frames.map(frame => frame.scheme))], [scenario.expected], `${scenario.name} native controls`)
      assert.equal(new Set(frames.map(frame => frame.color)).size, 1, `${scenario.name} paints one canvas before/after the bundle`)
      assert.equal(new Set(frames.map(frame => frame.chrome)).size, 1, `${scenario.name} paints one browser chrome color`)
      check(scenario.name, frames)
    } finally { await context.close() }
  }

  const page = await browser.newPage()
  const peer = await browser.newPage()
  try {
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])
    await peer.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])
    await page.goto(url, { waitUntil: "networkidle2" })
    await peer.goto(url, { waitUntil: "networkidle2" })
    const set = async preference => page.evaluate(async preference => { const theme = await import("/src/lib/theme.ts"); theme.setThemePreference(preference) }, preference)
    const resolved = async (target, expected) => target.waitForFunction(expected => document.documentElement.dataset.theme === expected, {}, expected)
    await set("light")
    await resolved(peer, "light")
    check("A second tab adopts an explicit choice")
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }])
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])
    await resolved(page, "light")
    check("Explicit Light ignores OS changes")
    await set("system")
    await resolved(page, "dark")
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }])
    await resolved(page, "light")
    assert.equal(await page.evaluate(() => localStorage.getItem("frizz-theme")), "system")
    check("System reacts live without persisting the resolved theme")
    await page.evaluate(() => localStorage.removeItem("frizz-theme"))
    await resolved(peer, "dark")
    assert.equal(await peer.evaluate(async () => (await import("/src/lib/theme.ts")).getThemeSnapshot().preference), "system")
    await set("light")
    await resolved(peer, "light")
    await page.evaluate(() => localStorage.clear())
    await resolved(peer, "dark")
    check("Storage removal and clear restore System in the other tab")
    await set("light")
    for (const route of [new URL("/", url).href, new URL("/project/second-project", url).href, `${url}/thread/theme-rich/full`, url]) {
      await page.goto(route, { waitUntil: "networkidle2" })
      await resolved(page, "light")
    }
    check("Light survives grid, other project, deep link and reload navigation")

    await page.evaluate(() => Object.defineProperty(Storage.prototype, "setItem", { configurable: true, value() { throw new DOMException("Full", "QuotaExceededError") } }))
    await set("dark")
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }])
    await resolved(page, "dark")
    check("Failed persistence keeps an explicit choice in memory across OS changes")
  } finally { await page.close(); await peer.close() }
}

export async function checkRichRendererState({ page, url, check }) {
  await page.goto(`${url}/thread/theme-rich/full`, { waitUntil: "networkidle2" })
  await page.waitForSelector('[data-mermaid-state="ready"]')
  const iframe = await page.waitForSelector('iframe[title="theme counter"]')
  const frame = await iframe.contentFrame()
  await frame.waitForSelector("#value")
  await frame.click("#increment")
  const before = await frame.evaluate(() => ({ identity: window.mountIdentity, value: document.querySelector("#value").value, color: getComputedStyle(document.querySelector("#series span")).backgroundColor }))
  const beforeSrc = await iframe.evaluate(el => el.src)
  await page.evaluate(async () => {
    window.richNode = document.querySelector('[data-mermaid-state="ready"]').parentElement
    const theme = await import("/src/lib/theme.ts")
    for (const preference of ["dark", "light", "dark", "light"]) theme.setThemePreference(preference)
  })
  await frame.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === "light")
  await page.waitForFunction(() => document.querySelectorAll('[data-mermaid-state="ready"]').length === 2 && !document.querySelector('[data-mermaid-state="loading"]'))
  const after = await frame.evaluate(() => ({ identity: window.mountIdentity, value: document.querySelector("#value").value, color: getComputedStyle(document.querySelector("#series span")).backgroundColor }))
  assert.equal(before.identity, after.identity)
  assert.equal(after.value, "43")
  assert.equal(await iframe.evaluate(el => el.src), beforeSrc)
  assert.equal(await iframe.evaluate(el => el.getAttribute("sandbox")), "allow-scripts")
  assert.equal(await page.evaluate(() => document.querySelector('[data-mermaid-state="ready"]').parentElement === window.richNode), true)
  assert.notEqual(after.color, before.color, "Chart colors respond to the selected palette")
  await page.waitForFunction(() => !document.querySelector('[id^="dfrizz-mermaid-"]'))
  check("Rapid theme changes preserve iframe controls and transcript nodes", { before, after })
  const initialHeight = await iframe.evaluate(el => el.getBoundingClientRect().height)
  await frame.evaluate(() => { const el = document.createElement("div"); el.style.height = "500px"; document.body.append(el) })
  await page.waitForFunction(initialHeight => document.querySelector('iframe[title="theme counter"]').getBoundingClientRect().height > initialHeight, {}, initialHeight)
  check("Iframe natural height still updates after theme application")
}
