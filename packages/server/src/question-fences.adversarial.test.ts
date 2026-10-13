// ADVERSARIAL COVERAGE FOR THE QUESTION REGISTRAR'S SERVER PIPELINE (2026-10-13): transcript → fold →
// sighting → row → RPC. Each test here pins a way the pipeline was found to break, or a seam a reviewer
// attacked that held and is worth keeping held. The companion file (question-fences.test.ts) carries the
// feature's own happy paths.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createAcpBackend } from "./backend/acp-transcript.ts"
import { applyEvent, newTailState } from "./tailer.ts"

const fence = (body: string) => `\`\`\`question\n${body}\n\`\`\``
const choice = (id: string, question = "SQLite or a JSON file?") =>
  fence(`id: ${id}\nkind: choice\nquestion: ${question}\noptions:\n  - label: SQLite\n    recommended: true\n  - label: JSON file`)
const at = (minute: number) => new Date(Date.parse("2026-10-20T10:00:00.000Z") + minute * 60_000).toISOString()

// ── The ACP fold: a message arrives as streamed PIECES ─────────────────────────────────────────────────
//
// The ACP bridge flushes an agent message's text every second (acp-bridge.ts flushText), so one message
// reaches the transcript as several `assistant-text` records sharing a messageId. A piece is not a
// message: it can begin INSIDE a code block that quotes the grammar, or end halfway through a fence.

const acpLine = (rec: object) => JSON.stringify(rec)

test("ACP: a streamed piece that begins inside a quoting code block registers nothing", () => {
  const acp = createAcpBackend({ stateDir: "/dev/null" })
  const s = newTailState("a", "sid-a", "/dev/null")
  const sample = fence("id: quoted-sample\nkind: text\nquestion: Only an example of the grammar")
  const whole = `The grammar looks like this:\n\n\`\`\`\`md\n${sample}\n\`\`\`\`\n\nThat is all.`
  // The bridge's flush landed just after the outer opener: the second piece starts inside it.
  const cut = whole.indexOf("```question")
  acp.foldLine(s, acpLine({ kind: "turn-start", at: at(0) }))
  acp.foldLine(s, acpLine({ kind: "assistant-text", at: at(0), text: whole.slice(0, cut), final: false, messageId: "m1" }))
  acp.foldLine(s, acpLine({ kind: "assistant-text", at: at(1), text: whole.slice(cut), final: true, messageId: "m1" }))
  acp.foldLine(s, acpLine({ kind: "turn-end", at: at(1), finalText: whole, successful: true }))
  assert.deepEqual(s.questionSightings ?? [], [], "a quoted sample is prose, however the bridge cut the message")
})

test("ACP: a fence split across two streamed pieces mid-turn is sighted once, at the message's own instant", () => {
  const acp = createAcpBackend({ stateDir: "/dev/null" })
  const s = newTailState("a", "sid-a", "/dev/null")
  const whole = `Before I go on:\n\n${choice("settings-store")}\n\nRunning the build meanwhile.`
  const cut = whole.indexOf("options:")
  acp.foldLine(s, acpLine({ kind: "turn-start", at: at(0) }))
  acp.foldLine(s, acpLine({ kind: "assistant-text", at: at(0), text: whole.slice(0, cut), final: false, messageId: "m1" }))
  acp.foldLine(s, acpLine({ kind: "assistant-text", at: at(1), text: whole.slice(cut), final: false, messageId: "m1" }))
  // A tool call ends the message: the text after it is a new one, and nothing echoes the commentary.
  acp.foldLine(s, acpLine({ kind: "tool-call", at: at(2), id: "t1", name: "bash", input: {} }))
  acp.foldLine(s, acpLine({ kind: "assistant-text", at: at(3), text: "Build is green.", final: true, messageId: "m2" }))
  acp.foldLine(s, acpLine({ kind: "turn-end", at: at(3), finalText: "Build is green.", successful: true }))
  assert.deepEqual(s.questionSightings, [{ at: at(0), text: choice("settings-store") }])
})

test("ACP: the final message's pieces and the turn-end echo are ONE sighting", () => {
  const acp = createAcpBackend({ stateDir: "/dev/null" })
  const s = newTailState("a", "sid-a", "/dev/null")
  const whole = `Needs you:\n\n${choice("settings-store")}`
  const cut = whole.indexOf("kind:")
  acp.foldLine(s, acpLine({ kind: "assistant-text", at: at(0), text: whole.slice(0, cut), final: false, messageId: "m1" }))
  acp.foldLine(s, acpLine({ kind: "assistant-text", at: at(1), text: whole.slice(cut), final: true, messageId: "m1" }))
  acp.foldLine(s, acpLine({ kind: "turn-end", at: at(2), finalText: whole, successful: true }))
  assert.deepEqual(s.questionSightings, [{ at: at(0), text: choice("settings-store") }])
})

// ── The codex fold: the final answer is written twice ─────────────────────────────────────────────────

test("codex: the final answer echoed on task_complete a beat later is one sighting, not two", () => {
  const c = newTailState("c", "sid-c", "/dev/null")
  applyEvent(c, { kind: "turn-start", at: at(0) })
  applyEvent(c, { kind: "assistant-text", text: choice("end"), final: true, at: at(1) })
  // task_complete carries its own, later, timestamp (codex.ts) — the existing test used the same instant.
  applyEvent(c, { kind: "turn-end", finalText: choice("end"), at: at(2) })
  assert.deepEqual(c.questionSightings?.map((x) => x.at), [at(1)])
  // …and a turn-end whose final text no assistant-text carried is still noted, at its own instant.
  const d = newTailState("d", "sid-d", "/dev/null")
  applyEvent(d, { kind: "turn-start", at: at(0) })
  applyEvent(d, { kind: "turn-end", finalText: choice("only-on-bracket"), at: at(2) })
  assert.deepEqual(d.questionSightings?.map((x) => x.at), [at(2)])
})
