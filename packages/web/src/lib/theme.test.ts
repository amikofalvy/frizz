import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import { parseThemePreference, resolveTheme } from "./theme.ts"

test("theme preferences validate independently from the resolved appearance", () => {
  assert.equal(parseThemePreference("system"), "system")
  assert.equal(parseThemePreference("light"), "light")
  assert.equal(parseThemePreference("dark"), "dark")
  assert.equal(parseThemePreference("sepia"), "system")
  assert.equal(resolveTheme("system", false), "light")
  assert.equal(resolveTheme("system", true), "dark")
  assert.equal(resolveTheme("light", true), "light")
  assert.equal(resolveTheme("dark", false), "dark")
})

test("the pre-paint resolver handles stored, denied-storage, and unavailable-media inputs", () => {
  const entry = readFileSync(new URL("../../index.html", import.meta.url), "utf8")
  const script = [...entry.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1]
  assert.ok(script)
  const run = ({ stored, storageFails = false, systemDark = false, mediaAvailable = true }: { stored?: string | null; storageFails?: boolean; systemDark?: boolean; mediaAvailable?: boolean }) => {
    const meta = { content: "#0d0e10", setAttribute(_: string, value: string) { this.content = value } }
    const documentElement = { dataset: {} as Record<string, string>, style: {} as Record<string, string> }
    vm.runInNewContext(script, {
      localStorage: { getItem: () => { if (storageFails) throw new Error("denied"); return stored ?? null } },
      matchMedia: mediaAvailable ? () => ({ matches: systemDark }) : undefined,
      document: { documentElement, querySelector: () => meta },
    })
    return { documentElement, meta }
  }
  assert.deepEqual(run({ stored: "dark" }).documentElement.dataset, { theme: "dark" })
  assert.deepEqual(run({ storageFails: true, systemDark: true }).documentElement.dataset, { theme: "dark" })
  const noMedia = run({ storageFails: true, mediaAvailable: false })
  assert.equal(noMedia.documentElement.dataset.theme, "light")
  assert.equal(noMedia.documentElement.style.colorScheme, "light")
  assert.equal(noMedia.meta.content, "#f6f8fa")
})

test("the runtime and pre-paint resolver share the dedicated preference key and canvas values", () => {
  const entry = readFileSync(new URL("../../index.html", import.meta.url), "utf8")
  const runtime = readFileSync(new URL("./theme.ts", import.meta.url), "utf8")
  assert.match(entry, /frizz-theme/)
  assert.match(entry, /#f6f8fa/)
  assert.match(runtime, /THEME_STORAGE_KEY = "frizz-theme"/)
  assert.match(runtime, /LIGHT_CANVAS = "#f6f8fa"/)
})
