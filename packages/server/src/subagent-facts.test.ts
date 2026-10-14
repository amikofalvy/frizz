import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeContextUsage, readSubAgentContextUsage } from "./subagent-facts.ts"

// A sub-agent drawer's context reading comes off the child's OWN transcript, so these pin the two ways
// it could quietly read the wrong request: an older one than the last, or a record that is not a request.

const assistant = (model: string, usage: Record<string, number> | undefined, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", isSidechain: true, timestamp: "2026-10-14T20:19:22.756Z", message: { model, role: "assistant", content: [{ type: "text", text: "…" }], ...(usage ? { usage } : {}) }, ...extra })
const toolResult = JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", content: "the word \"usage\" in a tool's output" }] } })

test("a Claude child reads the LAST request's context: fresh input + cache written + cache read", () => {
  const text = [
    assistant("claude-sonnet-5-5", { input_tokens: 2, cache_creation_input_tokens: 47_246, cache_read_input_tokens: 5_483, output_tokens: 90 }),
    toolResult,
    assistant("claude-sonnet-5-5", { input_tokens: 2, cache_creation_input_tokens: 3_026, cache_read_input_tokens: 68_705, output_tokens: 412 }),
    toolResult,
    "",
  ].join("\n")
  // Output tokens are not in the context until the next request quotes them back.
  assert.deepEqual(claudeContextUsage(text), { tokens: 71_733, model: "claude-sonnet-5-5" })
})

test("an API-error record and a synthetic model never stand in for a real request", () => {
  const text = [
    assistant("claude-opus-5-5", { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 40_000 }),
    assistant("<synthetic>", { input_tokens: 0, output_tokens: 0 }, { isApiErrorMessage: true }),
  ].join("\n")
  assert.deepEqual(claudeContextUsage(text), { tokens: 40_010, model: "claude-opus-5-5" })
})

test("a compaction after the last request reads its post-compaction size", () => {
  const text = [
    assistant("claude-opus-5-5", { input_tokens: 5, cache_read_input_tokens: 180_000 }),
    JSON.stringify({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 180_005, postTokens: 6_120 } }),
  ].join("\n")
  assert.deepEqual(claudeContextUsage(text), { tokens: 6_120, model: "claude-opus-5-5" })
})

test("a transcript with no request yet has no reading", () => {
  assert.equal(claudeContextUsage([toolResult, assistant("claude-opus-5-5", undefined)].join("\n")), undefined)
  assert.equal(readSubAgentContextUsage("/nonexistent/agent.jsonl"), undefined)
})

test("a codex child reads tokens AND window off its last token_count", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-subagent-facts-"))
  try {
    const fixture = readFileSync(new URL("./backend/codex.fixtures/exec-two-turn.jsonl", import.meta.url), "utf8")
    const path = join(dir, "rollout.jsonl")
    writeFileSync(path, fixture)
    const reading = readSubAgentContextUsage(path, "codex")
    assert.ok(reading, "the fixture's token_count lines read")
    assert.equal(reading.window, 258_400)
    const lastTotal = fixture.trim().split("\n").filter((line) => line.includes("\"token_count\"")).map((line) => JSON.parse(line).payload.info?.last_token_usage?.total_tokens).filter((n) => typeof n === "number").at(-1)
    assert.equal(reading.tokens, lastTotal, "the LAST reading, not the first")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
