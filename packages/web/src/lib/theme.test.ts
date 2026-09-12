import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
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

test("the pre-paint guard and runtime share the dedicated preference key and canvas values", () => {
  const entry = readFileSync(new URL("../../index.html", import.meta.url), "utf8")
  const runtime = readFileSync(new URL("./theme.ts", import.meta.url), "utf8")
  assert.match(entry, /frizz-theme/)
  assert.match(entry, /#f6f8fa/)
  assert.match(runtime, /THEME_STORAGE_KEY = "frizz-theme"/)
  assert.match(runtime, /LIGHT_CANVAS = "#f6f8fa"/)
})
