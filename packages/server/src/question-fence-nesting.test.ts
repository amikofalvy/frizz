// A ```question fence may hold a code block (shared code-fences.ts questionFenceClose, 2026-10-13). The
// scanner that learned it — `fencedInteriors` — is shared by readers that have nothing to do with
// questions, so this pins what each of the server's must still do: the signal-fence read, the legacy
// pending-question flag, and the fold that hands the registrar its sightings.

import { test } from "node:test"
import assert from "node:assert/strict"
import { questionFencesIn } from "@frizz/shared"
import { applyRecord, hasQuestionBlock, newTailState, parseSignalFence } from "./tailer.ts"

// A question whose context holds a sql block, written with three backticks on both — the shape a real
// Haiku reply took.
const NESTED = "```question\nid: run-migration\nkind: text\nquestion: Run it?\n---\nThe statements:\n\n```sql\nALTER TABLE orders ADD COLUMN archived_at timestamptz;\n```\n\nBoth are safe to re-run.\n```"

test("a done or awaiting fence after a question holding a code block is still the message's signal fence", () => {
  assert.deepEqual(parseSignalFence(`${NESTED}\n\n\`\`\`awaiting\nstatus: blocked\n\`\`\``)?.kind, "awaiting")
  assert.deepEqual(parseSignalFence(`${NESTED}\n\n\`\`\`done\nShipped.\n\`\`\``), { kind: "done", body: "Shipped.", hints: [] })
  // The control: a signal fence with prose after it is no signal, whatever came before.
  assert.equal(parseSignalFence(`${NESTED}\n\n\`\`\`done\nShipped.\n\`\`\`\n\nOne more thing.`), undefined)
})

test("the fold keeps the whole question, and a second one written after it", () => {
  const s = newTailState("t", "sid-t", "/dev/null")
  const second = "```question\nid: backfill\nkind: text\nquestion: Backfill too?\n```"
  applyRecord(s, {
    type: "assistant", timestamp: "2026-10-20T10:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: `The migration is ready.\n\n${NESTED}\n\n${second}\n\n\`\`\`awaiting\nstatus: blocked\n\`\`\`` }], stop_reason: "end_turn" },
  } as never)
  assert.equal(s.questionSightings?.length, 1)
  assert.equal(s.questionSightings?.[0].text, `${NESTED}\n\n${second}`, "each fence's own source, whole, and nothing between them")
  const assembled = questionFencesIn(s.questionSightings?.[0].text ?? "")
  assert.deepEqual(assembled.faults, [])
  assert.deepEqual(assembled.asks.map((a) => a.id), ["run-migration", "backfill"])
  assert.match(assembled.asks[0].spec.context ?? "", /```sql\n[^]*```\n\nBoth are safe to re-run\.$/)
})

test("the legacy pending-question flag reads a free-form fence, a marker and a quoted sample as it did", () => {
  assert.equal(hasQuestionBlock("Pick one:\n\n```question\nWhich store?\n- A. SQLite\n- B. JSON\n```"), true)
  assert.equal(hasQuestionBlock("```question multi\nWhich?\n- A. x\n- B. y\n```"), true)
  assert.equal(hasQuestionBlock("The grammar:\n\n````md\n```question\nWhich store?\n```\n````"), false)
  assert.equal(hasQuestionBlock("```sql\nSELECT 1\n\n```question\nWhich store?\n```"), false, "inside a code block left open")
  // …and one that holds a code block is a question block still.
  assert.equal(hasQuestionBlock(NESTED), true)
})
