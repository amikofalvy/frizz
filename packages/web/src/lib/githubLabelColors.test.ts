import assert from "node:assert/strict"
import test from "node:test"
import { githubLabelColors } from "./githubLabelColors.ts"

test("GitHub label colors preserve valid external hues through semantic CSS treatments", () => {
  for (const color of ["fef2c0", "ffffff", "000001", "D73A4A"]) {
    const treatment = githubLabelColors(color)
    assert.match(treatment.foreground, /var\(--color-fg\)/)
    assert.match(treatment.background, /var\(--color-panel\)/)
    assert.match(treatment.border, /var\(--color-border\)/)
    assert.match(`${treatment.foreground}${treatment.background}${treatment.border}`, new RegExp(`#${color.toLowerCase()}`, "i"))
  }
})

test("malformed external label colors use semantic neutral treatments", () => {
  for (const color of ["", "white", "#fff", "#ffffff00", "url(javascript:alert(1))"]) {
    assert.deepEqual(githubLabelColors(color), {
      foreground: "var(--color-muted)",
      background: "color-mix(in srgb, var(--color-muted) 10%, var(--color-panel))",
      border: "color-mix(in srgb, var(--color-muted) 30%, var(--color-border))",
    })
  }
})
