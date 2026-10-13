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
import { readFileSync } from "node:fs"
import { Lexer, type Token } from "marked"
import { questionFenceBlocks, questionFencesIn, questionHandles } from "@frizz/shared"
import { splitFenceBlocks } from "./fenceBlocks.ts"
import { questionFenceIdsIn, splitMessageQuestions, splitQuestionBlocks } from "./questionBlocks.ts"

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

// The models lane's real replies and its probe, verbatim (shared fixtures/question-fence — the same files
// the parser's own tests read).
const fixture = (name: string) => readFileSync(new URL(`../../../shared/src/fixtures/question-fence/${name}.md`, import.meta.url), "utf8")
const REPLY_THREE_THREE = fixture("haiku-three-outside-three-inside")
const REPLY_THREE_FOUR = fixture("haiku-three-outside-four-inside")
const REPLY_NEVER_CLOSED = fixture("haiku-four-inside-never-closed")
const REPLY_LONGER_CLOSER = fixture("haiku-three-open-four-close")
const PROBE_TWO_QUESTIONS = fixture("probe-two-questions-code-in-context")

const PROBE_DETAIL_CODE = fence("id: retry-backoff\nkind: choice\nquestion: Which backoff?\noptions:\n  - label: Exponential\n    detail: |\n      ```diff\n      -  await sleep(100)\n      ```\n  - label: Keep the fixed sleep")

// A question holding a code block, written with the outer fence no longer than the inner one.
const NESTED = fence(`${TEXT}\n---\nRun this:\n\n\`\`\`sql\nSELECT 1\n\`\`\`\n\nand tell me.`)

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
  "code in the context, fences the same length": `Lead.\n\n${NESTED}\n\nAfter.`,
  "code in the context, then a second question": `${NESTED}\n\n${fence("id: y\nkind: text\nquestion: Y?")}`,
  "code in the context, then a done fence": `${NESTED}\n\n\`\`\`done\nShipped.\n\`\`\``,
  "code in the context, then an awaiting fence": `${NESTED}\n\n\`\`\`awaiting\nstatus: blocked\n\`\`\``,
  "code in the context, the question never closed": `Lead.\n\n\`\`\`question\n${TEXT}\n---\n\`\`\`\`sql\nSELECT 1\n\`\`\`\`\n\nNotes.`,
  "a bare code block in the context": `${fence(`${TEXT}\n---\nRun:\n\`\`\`\nls\n\`\`\`\ntell me`)}`,
  "probe: two questions, code in the first one's context": PROBE_TWO_QUESTIONS,
  "probe: three-tick fence, code in a detail": PROBE_DETAIL_CODE,
  "reply: three outside, three inside": REPLY_THREE_THREE,
  "reply: three outside, four inside": REPLY_THREE_FOUR,
  "reply: four inside, the question never closed": REPLY_NEVER_CLOSED,
  "reply: opened with three, closed with four": REPLY_LONGER_CLOSER,
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

test("a question holding a code block: the server registers it whole and the web cuts the same span", () => {
  // The four replies and the probe, each as [what registers, how many corrections].
  const expected: [string, string[], number][] = [
    ["reply: three outside, three inside", ["orders-archived-at-prod"], 0],
    ["reply: three outside, four inside", ["orders-archived-at-migration"], 0],
    // Its sql block is closed and the question never is: refused by name, and drawn by nobody as a card.
    ["reply: four inside, the question never closed", [], 1],
    // A whole question with no context; the SQL after it is the message's own prose.
    ["reply: opened with three, closed with four", ["approve-orders-archived-at-migration"], 0],
    // The second question used to be swallowed by the block the first one's real closer opened.
    ["probe: two questions, code in the first one's context", ["orders-archived-at", "orders-backfill"], 0],
    ["probe: three-tick fence, code in a detail", ["retry-backoff"], 0],
  ]
  for (const [name, ids, faults] of expected) {
    const v = view(inputs[name])
    assert.deepEqual([v.server, v.web, v.faults], [ids, ids, faults], name)
  }
  // THE SPAN. What the web hands marked is the message with each question cut out at the shared reader's
  // offsets — so no half of a fence is left behind for marked to open a code block on.
  for (const name of ["code in the context, fences the same length", "reply: three outside, three inside", "reply: three outside, four inside", "probe: two questions, code in the first one's context"]) {
    const segments = splitMessageQuestions(inputs[name], true)
    const prose = segments.flatMap((s) => (s.kind === "prose" ? [s.text] : []))
    for (const text of prose) assert.doesNotMatch(text, /^ {0,3}(`{3,}|~{3,})/m, `${name}: no fence line is left in the prose`)
    assert.deepEqual(prose.flatMap((text) => markedView(text)), [], name)
    // …and the card's context is the worker's whole body, its code block closed.
    for (const s of segments) {
      if (s.kind !== "question" || s.fence?.form !== "ask" || !s.fence.spec.context?.includes("sql")) continue
      const context = new Lexer({ gfm: true }).lex(s.fence.spec.context)
      assert.ok(context.some((t) => t.type === "code" && (t as { lang?: string }).lang === "sql"), `${name}: the context draws a sql block`)
      for (const t of context) if (t.type === "code") assert.match(t.raw.trimEnd(), /\n`{3,}$/, `${name}: and every block in it is closed`)
    }
  }
  assert.deepEqual(splitMessageQuestions(inputs["code in the context, fences the same length"], true).map((s) => (s.kind === "prose" ? s.text : s.fence?.id)), ["Lead.\n\n", "x", "\nAfter."])
})

test("a done or awaiting fence written after a question that holds a code block is still a signal fence", () => {
  for (const [name, kind] of [["code in the context, then a done fence", "done"], ["code in the context, then an awaiting fence", "awaiting"]] as const) {
    const segments = splitFenceBlocks(inputs[name])
    assert.deepEqual(segments.map((s) => (s.kind === "fence" ? s.fenceKind : "prose")), ["prose", kind], name)
    // The prose run it leaves is the question, whole, which the question splitter then cuts as one card.
    const prose = segments[0].kind === "prose" ? segments[0].text : ""
    assert.deepEqual(splitMessageQuestions(prose, true).map((s) => (s.kind === "question" ? s.fence?.id : "prose")), ["x"], name)
  }
  // The control: the same signal fence inside a code block that really is open stays quoted.
  assert.deepEqual(splitFenceBlocks("```sql\nSELECT 1\n\n```done\nShipped.\n```").map((s) => s.kind), ["prose"])
})

test("a legacy thread reads its fences as it always did", () => {
  // A placement marker (an info string with a token after `question`) and a ```question multi block are
  // not the nesting grammar: nothing about where they end, or what follows them, moves.
  const marker = "Before.\n\n```question qst_abcdef123456\n```\n\nAfter, with code:\n\n```sql\nSELECT 1\n```\n\n```done\nShipped.\n```"
  assert.deepEqual(splitFenceBlocks(marker).map((s) => (s.kind === "fence" ? s.fenceKind : "prose")), ["prose", "done"])
  assert.deepEqual(splitQuestionBlocks(marker).map((s) => (s.kind === "question" ? s.registeredId : "prose")), ["prose", "qst_abcdef123456", "prose"])
  const multi = "```question multi\nWhich?\n- A. x\n- B. y\n```\n\n```sql\nSELECT 1\n```\n\n```awaiting\nstatus: blocked\n```"
  assert.deepEqual(splitFenceBlocks(multi).map((s) => (s.kind === "fence" ? s.fenceKind : "prose")), ["prose", "awaiting"])
  assert.deepEqual(splitQuestionBlocks(multi).map((s) => (s.kind === "question" ? s.questionKind : "prose")), ["multi", "prose"])
  // A free-form ```question block — the legacy grammar's own ask — followed by a second one.
  const freeForm = "```question\nWhich store?\n- A. SQLite\n- B. JSON\n```\n\nAnd:\n\n```question\nWhich port?\n```"
  assert.deepEqual(splitQuestionBlocks(freeForm).map((s) => s.kind), ["question", "prose", "question"])
  assert.deepEqual(splitMessageQuestions(freeForm, false), splitQuestionBlocks(freeForm))
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
