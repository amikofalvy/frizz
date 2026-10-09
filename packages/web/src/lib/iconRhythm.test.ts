import assert from "node:assert/strict"
import test from "node:test"
import { composerRail } from "./iconRhythm.ts"

// The offsets every composer drew before the microphone existed, as Tailwind classes measured with
// scripts/ink-gaps.mjs. With no microphone the function must reproduce them exactly.
test("without a microphone the rail keeps its measured offsets", () => {
  assert.deepEqual(composerRail({}), { right: { send: 8, paperclip: 44 }, reserve: 80 })
  assert.deepEqual(composerRail({ action: true }), { right: { send: 8, action: 43, paperclip: 71 }, reserve: 107 })
  assert.deepEqual(composerRail({ lead: true }), { right: { send: 8, paperclip: 44, lead: 71 }, reserve: 107 })
  assert.deepEqual(composerRail({ action: true, lead: true }), { right: { send: 8, action: 43, paperclip: 71, lead: 98 }, reserve: 134 })
})

test("the microphone sits beside send and the marks to its left close up behind it", () => {
  const plain = composerRail({ mic: true })
  assert.ok(plain.right.mic! > 8 && plain.right.paperclip! > plain.right.mic!)
  const all = composerRail({ mic: true, action: true, lead: true })
  const order = (["send", "mic", "action", "paperclip", "lead"] as const).map((m) => all.right[m]!)
  assert.deepEqual([...order].sort((a, b) => a - b), order, "right to left: send, mic, action, paperclip, lead")
  assert.equal(all.reserve, all.right.lead! + 28 + 8)
})
