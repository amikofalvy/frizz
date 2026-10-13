// WHERE THE SERVER, THE WEB AND THE PROSE RENDERER EACH THINK A QUESTION FENCE IS — run over the same inputs.
//
// Three readers have an opinion about a ```question fence in a message:
//   · the SERVER registers a row for what `questionFencesIn` assembles (question-fences.ts syncQuestionFences);
//   · the WEB draws a card where `splitMessageQuestions` cuts a fence segment, and counts a message as naming
//     a question by `questionFenceIdsIn` (lib/questionAnchor, lib/questionShadow);
//   · MARKED draws everything the web did not cut out, so it decides what a fence the other two ignored
//     looks like: a code block labelled `question`, or raw HTML, or prose.
//
// The first two share one reader (shared question-fence.ts questionFenceBlocks), so they agree by construction
// about where a fence IS. This file pins that, and writes down every place the three still part ways, so a
// change to any of them shows up here as a named difference rather than as a card that is drawn and never
// registered. Written for the adversarial review of 2026-10-13; the inputs are the shapes that review tried.

import { test } from "node:test"
import assert from "node:assert/strict"
import { Lexer, type Token } from "marked"
import { questionFenceBlocks, questionFencesIn, questionHandles } from "@frizz/shared"
import { questionFenceIdsIn, splitMessageQuestions } from "./questionBlocks.ts"

const TEXT = "id: x\nkind: text\nquestion: Q?"
const fence = (body: string, ticks = "```") => `${ticks}question\n${body}\n${ticks}`
const indented = (text: string, pad: string) => text.split("\n").map((l) => pad + l).join("\n")
const choice = (id: string, when?: string) => fence(`id: ${id}\nkind: choice\n${when ? `when: ${when}\n` : ""}question: ${id}?\noptions:\n  - go\n  - no`)

interface View {
  /** Root ids the server would register, then ids it would take as references. */
  server: string[]
  /** How many fences the server would answer with a correction. */
  faults: number
  /** Ids the web cuts a card slot for (a `when:` follow-up draws inside its parent's card, so it is not one). */
  web: string[]
  /** Fences the web hands to the LEGACY free-form card: an invalid read keeps the rendering it had. */
  legacyCards: number
  /** What marked makes of the whole message: every `question` code block, and every fence it read as HTML. */
  marked: string[]
}

function markedView(text: string): string[] {
  const out: string[] = []
  const walk = (tokens: Token[], path: string) => {
    for (const t of tokens) {
      if (t.type === "code" && /^question$/i.test((t as { lang?: string }).lang ?? "")) out.push(`${path}code`)
      if (t.type === "html" && t.raw.includes("```question")) out.push(`${path}html`)
      const kids = (t as { tokens?: Token[] }).tokens
      if (kids) walk(kids, `${path}${t.type}>`)
      for (const item of (t as { items?: { tokens?: Token[] }[] }).items ?? []) walk(item.tokens ?? [], `${path}item>`)
    }
  }
  walk(new Lexer({ gfm: true, breaks: true }).lex(text), "")
  return out
}

function view(text: string): View {
  const assembled = questionFencesIn(text)
  const segments = splitMessageQuestions(text, true)
  return {
    server: [...assembled.asks.map((a) => a.id), ...assembled.refs],
    faults: assembled.faults.length,
    web: segments.flatMap((s) => (s.kind === "question" && s.fence && !(s.fence.form === "ask" && s.fence.when) ? [s.fence.id] : [])),
    legacyCards: segments.filter((s) => s.kind === "question" && !s.fence).length,
    marked: markedView(text),
  }
}

// ── The inputs ─────────────────────────────────────────────────────────────────────────────────────────

const PROBE_CONTEXT_CODE = [
  "The migration is ready; approve it from the card.",
  "",
  "```question",
  "id: orders-archived-at",
  "kind: choice",
  "question: Should this migration run against production?",
  "options:",
  "  - label: Run it",
  "    recommended: true",
  "  - label: Hold it",
  "---",
  "The exact statements:",
  "",
  "```sql",
  "ALTER TABLE orders ADD COLUMN archived_at timestamptz;",
  "```",
  "",
  "Both are safe to re-run after a failure.",
  "```",
  "",
  "```question",
  "id: orders-backfill",
  "kind: choice",
  "question: Should archived rows be backfilled in the same deploy?",
  "options:",
  "  - Backfill now",
  "  - Leave it for a follow-up",
  "```",
].join("\n")

const PROBE_DETAIL_CODE = fence("id: retry-backoff\nkind: choice\nquestion: Which backoff?\noptions:\n  - label: Exponential\n    detail: |\n      ```diff\n      -  await sleep(100)\n      ```\n  - label: Keep the fixed sleep")

// A real Haiku reply's shape: opened with three backticks, closed with four, the SQL written after it.
const HAIKU_LONGER_CLOSER = "The SQL is in the card below.\n\n```question\nid: approve-migration\nkind: choice\nquestion: Run this migration?\noptions:\n  - Approve and run\n  - Decline\n````\n\n**Run as one migration.**\n\n```sql\nSET lock_timeout = '5s';\n```\n\nTell me if your naming differs."

const handMade: Record<string, string> = {
  plain: `Lead.\n\n${fence(TEXT)}\n\nAfter.`,
  crlf: `Lead.\r\n\r\n${fence(TEXT).replace(/\n/g, "\r\n")}\r\n`,
  "tilde fence": `~~~question\n${TEXT}\n~~~`,
  "indented 3": indented(fence(TEXT), "   "),
  "indented 3, body flush": `   \`\`\`question\n${TEXT}\n   \`\`\``,
  "indented 4": indented(fence(TEXT), "    "),
  "tab-indented": indented(fence(TEXT), "\t"),
  "in a numbered list": `1. First\n2. Then:\n\n${indented(fence(TEXT), "   ")}\n3. Last`,
  "in a tight bullet": `- a\n${indented(fence(TEXT), "  ")}`,
  "in a blockquote": indented(fence(TEXT), "> "),
  "in <details>, blank line": `<details>\n<summary>s</summary>\n\n${fence(TEXT)}\n\n</details>`,
  "in <details>, no blank line": `<details>\n<summary>s</summary>\n${fence(TEXT)}\n</details>`,
  "in an HTML comment": `<!--\n${fence(TEXT)}\n-->`,
  "quoted in a longer fence": `\`\`\`\`md\n${fence(TEXT)}\n\`\`\`\``,
  "quoted in a tilde fence": `~~~md\n${fence(TEXT)}\n~~~`,
  "unclosed (a streaming tail)": `Lead.\n\n\`\`\`question\n${TEXT}`,
  "closer with trailing spaces": `${fence(TEXT)}   `,
  "closer longer than the opener": `\`\`\`question\n${TEXT}\n\`\`\`\`\``,
  "closer shorter than the opener": `\`\`\`\`question\n${TEXT}\n\`\`\`\n\`\`\`\``,
  "info string with a trailing space": `\`\`\`question \n${TEXT}\n\`\`\``,
  "info string capitalised": `\`\`\`Question\n${TEXT}\n\`\`\``,
  "zero-width space before the opener": `​${fence(TEXT)}`,
  "legacy marker": "```question qst_abcdef123456\n```",
  "legacy multi": "```question multi\nWhich?\n- A. x\n- B. y\n```",
  "after an unclosed code block": `Code:\n\`\`\`js\nconst a = 1\n\n${fence(TEXT)}`,
  "after inline triple backticks": `Use \`\`\`question fences.\n\n${fence(TEXT)}`,
  "straight after a table": `| a | b |\n|---|---|\n| 1 | 2 |\n${fence(TEXT)}`,
  "straight after a paragraph": `Some prose line\n${fence(TEXT)}`,
  "a reference": fence("id: x"),
  "an invalid kind": fence("id: x\nkind: pick\nquestion: Q?"),
  "an invalid four-backtick fence": fence("id: x\nkind: pick\nquestion: Q?", "````"),
  "a follow-up beside its parent": `${choice("p")}\n\n${fence("id: c\nkind: text\nwhen: p = go\nquestion: C?")}`,
  "an orphan follow-up": fence("id: c\nkind: text\nwhen: p = go\nquestion: C?"),
  "a loop of follow-ups": `${choice("a", "b = go")}\n${choice("b", "a = go")}`,
  "a tree four deep": `${choice("a")}\n${choice("b", "a = go")}\n${choice("c", "b = go")}\n${fence("id: d\nkind: text\nwhen: c = go\nquestion: D?")}`,
  "two questions on one id": `${fence(TEXT)}\n${fence("id: x\nkind: text\nquestion: Different?")}`,
  "context with a longer outer fence": `${fence(`${TEXT}\n---\n\`\`\`sh\nls\n\`\`\`\nmore`, "````")}\n\nTail.`,
  "probe: three-tick fence, code in its context": PROBE_CONTEXT_CODE,
  "probe: three-tick fence, code in a detail": PROBE_DETAIL_CODE,
  "probe: opened with three, closed with four": HAIKU_LONGER_CLOSER,
}

const wrappers: Record<string, (s: string) => string> = {
  bare: (s) => s,
  "under a paragraph": (s) => `Intro paragraph.\n${s}`,
  "in a bullet": (s) => `- item\n\n${indented(s, "  ")}`,
  "in a numbered item": (s) => `1. item\n\n${indented(s, "   ")}`,
  "in a blockquote": (s) => indented(s, "> "),
  "in <details>": (s) => `<details>\n\n${s}\n\n</details>`,
  "quoted in a longer fence": (s) => `\`\`\`\`\`text\n${s}\n\`\`\`\`\``,
  crlf: (s) => s.replace(/\n/g, "\r\n"),
  "one space in": (s) => indented(s, " "),
}
const variants: Record<string, string> = {
  text: fence(TEXT),
  choice: fence("id: y\nkind: choice\nquestion: Pick?\noptions:\n  - label: A\n    description: d\n  - B"),
  "context with code": fence("id: z\nkind: text\nquestion: Z?\n---\n```sh\nls\n```", "````"),
  reference: fence("id: x"),
}
const generated: Record<string, string> = {}
for (const [w, wrap] of Object.entries(wrappers)) for (const [v, text] of Object.entries(variants)) generated[`${v}, ${w}`] = wrap(text)

const inputs = { ...handMade, ...generated }

// ── What must always hold ──────────────────────────────────────────────────────────────────────────────

test("the id helper and the splitter name the same fences, in the same order, on every input", () => {
  for (const [name, text] of Object.entries(inputs)) assert.deepEqual(questionFenceIdsIn(text), view(text).web, name)
})

test("the web cuts the message exactly where the shared reader found a fence, and loses none of it", () => {
  for (const [name, text] of Object.entries(inputs)) {
    const valid = questionFenceBlocks(text).filter((b) => b.read.form !== "invalid")
    const cut = splitMessageQuestions(text, true).filter((s) => s.kind === "question" && s.fence)
    assert.equal(cut.length, valid.length, name)
    // Every block is the opener line through the closer line: nothing of the prose on either side.
    for (const b of valid) {
      const source = text.slice(b.start, b.end)
      assert.match(source, /^ {0,3}`{3,}question[ \t]*\r?\n/, name)
      assert.match(source.trimEnd(), /`{3,}$/, name)
    }
  }
})

test("what the server keeps of a message — each fence's own source — reads the same as the message did", () => {
  for (const [name, text] of Object.entries(inputs)) {
    const blocks = questionFenceBlocks(text)
    const kept = blocks.map((b) => text.slice(b.start, b.end).trimEnd()).join("\n\n")
    assert.deepEqual(questionFenceBlocks(kept).map((b) => b.read), blocks.map((b) => b.read), name)
  }
})

// ── Server against web ─────────────────────────────────────────────────────────────────────────────────

// The one way the two differ: the web reads each fence ALONE, and the server refuses some for what the whole
// message makes of them. A `when:` follow-up draws nothing of its own, so the only such fence the web still
// cuts a slot for is a ROOT whose tree the server refused. ChatView draws it read-only from the fence's own
// spec ("an ask with no row yet … never registers a fence it refused"), and it stays that way: a card the
// human can read and never answer, until the worker's correction lands a new one.
const WEB_ONLY: Record<string, string[]> = {
  "a tree four deep": ["a"],
}

test("the web cuts a card slot for exactly the ids the server registers or references", () => {
  const differing: Record<string, { server: string[]; web: string[] }> = {}
  for (const [name, text] of Object.entries(inputs)) {
    const v = view(text)
    // As SETS: two fences on one id are two slots, and ChatView draws a card in the first only.
    const ids = (list: string[]) => JSON.stringify([...new Set(list)].sort())
    if (ids(v.server) !== ids(v.web)) differing[name] = { server: v.server, web: v.web }
  }
  assert.deepEqual(differing, Object.fromEntries(Object.entries(WEB_ONLY).map(([name, web]) => [name, { server: [], web }])))
  // The control: the harness can see a difference — the server refuses the four-deep tree, with a fault.
  assert.equal(view(inputs["a tree four deep"]).faults, 1)
  assert.deepEqual(view(inputs.plain), { server: ["x"], faults: 0, web: ["x"], legacyCards: 0, marked: ["code"] })
})

test("a follow-up is the server's through its root and the web's through its parent's card", () => {
  const v = view(inputs["a follow-up beside its parent"])
  assert.deepEqual(v.server, ["p"])
  assert.deepEqual(v.web, ["p"])
  assert.deepEqual(questionHandles(questionFencesIn(inputs["a follow-up beside its parent"]).asks[0].spec), ["p", "c"])
  // …and one that hangs off nothing is refused by the server and drawn nowhere.
  for (const name of ["an orphan follow-up", "a loop of follow-ups"]) {
    const lost = view(inputs[name])
    assert.deepEqual([lost.server, lost.web], [[], []], name)
    assert.ok(lost.faults > 0, `${name}: the worker is told`)
  }
})

test("the models lane's three reproductions", () => {
  // Code in the context of a three-backtick fence: refused, and the second fence — swallowed by the block
  // the first one's real closer opened — is drawn by nobody. The fault is the only word the worker gets.
  const cut = view(PROBE_CONTEXT_CODE)
  assert.deepEqual([cut.server, cut.web, cut.faults], [[], [], 1])
  assert.equal(questionFencesIn(PROBE_CONTEXT_CODE).faults[0].id, "orders-archived-at")
  // Code in a detail, indented past where a closing fence counts: whole, on both sides.
  const detail = view(PROBE_DETAIL_CODE)
  assert.deepEqual([detail.server, detail.web, detail.faults], [["retry-backoff"], ["retry-backoff"], 0])
  // Opened with three, closed with four: a complete question with no context, and the SQL after it is the
  // message's prose. Both sides agree; nothing was cut off, so nothing is refused.
  const longer = view(HAIKU_LONGER_CLOSER)
  assert.deepEqual([longer.server, longer.web, longer.faults], [["approve-migration"], ["approve-migration"], 0])
  assert.equal(questionFencesIn(HAIKU_LONGER_CLOSER).asks[0].spec.context, undefined)
})

// ── Both against the renderer ──────────────────────────────────────────────────────────────────────────

test("what the shared reader takes for a fence, against what marked would have drawn there", () => {
  const read: string[] = []
  const unread: string[] = []
  for (const [name, text] of Object.entries(inputs)) {
    const blocks = questionFenceBlocks(text).length
    const drawn = view(text).marked
    // READ, BUT NOT A CODE BLOCK TO MARKED: the card is cut out of what marked takes for one HTML block, so
    // the tags around it are rendered as two halves.
    if (blocks > 0 && drawn.some((d) => d.endsWith("html"))) read.push(name)
    // A `question` CODE BLOCK TO MARKED, BUT NOT READ: the worker wrote something a markdown reader shows as
    // a question fence, nothing registers, and no correction says so.
    if (blocks === 0 && drawn.some((d) => d.endsWith("code"))) unread.push(name)
  }
  assert.deepEqual(read, ["in <details>, no blank line", "in an HTML comment"])
  assert.deepEqual(unread, [
    "tilde fence",
    "in a blockquote",
    "unclosed (a streaming tail)",
    "info string capitalised",
    "text, in a blockquote",
    "choice, in a blockquote",
    "context with code, in a blockquote",
    "reference, in a blockquote",
  ])
})

test("a fence the server refuses is drawn by the legacy card only when it is three backticks at the margin", () => {
  // An invalid read "keeps the rendering it had": splitQuestionBlocks over the same bytes. That reader knows
  // one opener — ```question at column 0 — so the same mistake draws three different ways.
  assert.equal(view(inputs["an invalid kind"]).legacyCards, 1)
  assert.equal(view(inputs["an invalid four-backtick fence"]).legacyCards, 0)
  assert.deepEqual(view(inputs["an invalid four-backtick fence"]).marked, ["code"])
  assert.equal(view(indented(inputs["an invalid kind"], "  ")).legacyCards, 0)
})
