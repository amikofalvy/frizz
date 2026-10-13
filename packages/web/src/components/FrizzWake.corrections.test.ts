import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QUESTION_FENCE_CORRECTION_LEAD, mergedWakeMessage, questionsCancelledWakeMessage } from "@frizz/shared"
import { FrizzWake } from "./FrizzWake.tsx"

// A FENCE CORRECTION IS NOT A MESSAGE. Arriving alone, the server drops its record and marks the fence it
// refused (transcript.ts); held with other wakes and delivered as ONE merged message, it reaches the chat
// as a part of that message, and MergedWake leaves it out by the shared `isParkCorrection`. The question
// fence's correction (2026-10-13) is one more lead in that family, so a merged delivery carrying it must
// draw only the wakes beside it.

const correction = `${QUESTION_FENCE_CORRECTION_LEAD}\`settings-store\` was refused: a known id with a different body. Pick a new id.`
// A wake drawn as a hairline with no markdown body, so the render needs no DOM sanitizer.
const other = questionsCancelledWakeMessage(2)

test("a merged delivery drops the question fence's correction and keeps the wake beside it", () => {
  const text = mergedWakeMessage([
    { reason: "question fence refused", message: correction },
    { reason: "note", message: other },
  ], Date.UTC(2026, 9, 13, 12, 0))
  const html = renderToStaticMarkup(createElement(FrizzWake, { text }))
  assert.doesNotMatch(html, /question fence/, "the correction is not drawn")
  assert.doesNotMatch(html, /settings-store/)
  assert.equal((html.match(/data-wake-divider=/g) ?? []).length, 1, "only the other wake's hairline is drawn")
})

test("negative control: the correction's part, under any other lead, is a wake and is drawn", () => {
  const text = mergedWakeMessage([
    { reason: "note", message: questionsCancelledWakeMessage(1) },
    { reason: "note", message: other },
  ], Date.UTC(2026, 9, 13, 12, 0))
  const both = renderToStaticMarkup(createElement(FrizzWake, { text }))
  const one = renderToStaticMarkup(createElement(FrizzWake, { text: mergedWakeMessage([
    { reason: "question fence refused", message: correction },
    { reason: "note", message: other },
  ], Date.UTC(2026, 9, 13, 12, 0)) }))
  assert.equal((both.match(/data-wake-divider=/g) ?? []).length, 2)
  assert.equal((one.match(/data-wake-divider=/g) ?? []).length, 1)
})
