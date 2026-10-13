// THE QUESTION FENCE — how a worker asks the human, written in its own message (maintainer 2026-10-13).
//
//     ```question
//     id: settings-store
//     kind: choice
//     question: Should the settings store use SQLite or a JSON file?
//     options:
//       - label: SQLite
//         description: transactional, and one store to back up
//         recommended: true
//       - label: JSON file
//     ---
//     Any markdown the human needs to answer cold: a table, a diff, a callout.
//     ```
//
// A NOVEL `id:` REGISTERS A ROW; A KNOWN ONE REFERENCES IT. The server reads every assistant message for
// these fences and registers each new id as a `thread_question` row, once, for the life of the thread
// (question-fences.ts in the server). A fence carrying `id:` alone names a question that already exists —
// it places that card at this point of this message and says the worker still needs the answer. Nothing
// about a question's lifecycle is inferred from prose: the id is explicit, the row is the lifecycle, and
// the row outlives the message that created it. That is what separates this from the two designs that were
// declined before it (PR #33, which guessed which fences were answered; and a fence that only GATED a
// registered row's rendering, which dropped a live question whenever a reference was forgotten).
//
// WHY A FENCE AND NOT A TOOL CALL. `frizzctl ask` worked — 4 failures in 220 calls — but 61% of those calls
// were the last tool call before the worker rested: a full request spent re-reading the whole context to
// register, followed by the handoff, which then copied the minted id back into a placement marker. Asking
// in the handoff itself removes both, and puts the question's words in the transcript where a plain
// terminal shows them.
//
// WHY STRUCTURED, NOT A MARKDOWN LIST. The first sketch read options off the body's closing list of bold
// labels, which guessed at layout: does the body end on a list, is the label bold, is the separator an em
// dash. Every field here is named instead, so nothing is inferred from layout and every mistake can be
// refused BY NAME. The body under `---` is free markdown precisely because nothing has to be parsed out of it.
//
// WHY NOT YAML. The front matter LOOKS like YAML and reads like it, but every value is prose, and YAML cannot
// hold prose: a backtick may not open a plain scalar, `: ` starts a mapping, ` #` starts a comment. The
// ```awaiting fence learned that one key at a time (`title:` 2026-09-10, `steps:` 2026-10-03) and now reads
// both verbatim. Here every value is read verbatim to the end of its line, a quoted value is unquoted, and an
// indented block under a key (`detail: |`) is taken as written.

import { parse as parseYaml } from "yaml"
import { fencedInteriors } from "./code-fences.ts"
import type { AskedOption, AskedQuestion } from "./index.ts"
import { askedQuestionFaults } from "./index.ts"

/** The four answer shapes a question fence declares, each explicit (maintainer 2026-10-13: "we need to have
 *  some pretty explicit options in terms of specifying multiple-choice answers versus other kinds"). */
export const QUESTION_FENCE_KINDS = ["choice", "multi", "text", "secret"] as const
export type QuestionFenceKind = (typeof QUESTION_FENCE_KINDS)[number]

/** Every key the front matter understands, in the order the contract teaches them. Anything else is
 *  refused by name, so a typo (`recomended`) is a correction rather than a silently ignored line.
 *  `header` is READ but not taught: `AskedQuestion.header` came from the `ask` tool, where it was
 *  described as the card's chip, and no surface has ever drawn it — so a worker that writes one is not
 *  faulted for it, and none is told to. */
export const QUESTION_FENCE_KEYS = ["id", "kind", "question", "options", "danger", "header", "when"] as const
export const QUESTION_FENCE_OPTION_KEYS = ["label", "description", "recommended", "detail"] as const

/** A worker's id: a lowercase slug, unique within its thread for the thread's life. `qst_` is reserved for
 *  the ids `frizzctl ask` minted, so a bare `qst_…` always names one of those. */
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const RESERVED_QUESTION_ID_PREFIX = "qst_"

/** The caps the `ask` schema holds (AskedQuestionSchema), restated where the fence is read so a fence that
 *  would fail the stored schema is refused here with a reason rather than dropped later. */
const QUESTION_MAX = 4000
const CONTEXT_MAX = 20000
const LABEL_MAX = 400
const DESCRIPTION_MAX = 20000
const HEADER_MAX = 24

export type QuestionFenceRead =
  /** A new question: its id, the tree node it registers (follow-ups attach at assembly), and its parent. */
  | { form: "ask"; id: string; spec: AskedQuestion; when?: { parent: string; option: string } }
  /** `id:` and nothing else — a question that already exists, placed here. */
  | { form: "ref"; id: string }
  /** Refused, with every reason, and the id when one could be read (so a correction can name it). */
  | { form: "invalid"; id?: string; faults: string[] }

export interface QuestionFenceBlock {
  /** Offset of the opening fence line's first character. */
  start: number
  /** Offset just past the closing fence line (its newline included when there is one). */
  end: number
  /** The text between the opening and closing lines. */
  body: string
  read: QuestionFenceRead
}

// An opener whose info string is exactly `question`. A ```question qst_… placement marker and the retired
// ```question multi / danger info strings are NOT this grammar — they carry tokens — and stay with the
// legacy readers (web lib/questionBlocks).
const OPENER_RE = /^( {0,3})(`{3,})question[ \t]*$/

/** Every question fence in a message, in order, skipping one that sits inside another code block — a
 *  worker DOCUMENTING the grammar wraps its sample in a longer fence, and that sample is not an ask. An
 *  unclosed fence is not a block: the renderer would run it to the end of the message, and nothing that
 *  never finished is registered. */
export function questionFenceBlocks(text: string): QuestionFenceBlock[] {
  if (!text.includes("question")) return []
  const quoted = fencedInteriors(text)
  // An interior starts at the first character after its opening line, so an opener on the very next line
  // sits AT `from` — inside.
  const inside = (offset: number) => quoted.some(([from, to]) => offset >= from && offset < to)
  const out: QuestionFenceBlock[] = []
  const lines = text.split("\n")
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "")
    const lineStart = offset
    offset += lines[i].length + 1
    const m = OPENER_RE.exec(line)
    if (!m || inside(lineStart)) continue
    const ticks = m[2].length
    // CommonMark's closer: a bare run of backticks at least as long as the opener, up to 3 spaces in.
    let close = -1
    let closeEnd = offset
    for (let j = i + 1, at = offset; j < lines.length; j++) {
      const candidate = lines[j].replace(/\r$/, "")
      at += lines[j].length + 1
      const c = /^ {0,3}(`{3,})[ \t]*$/.exec(candidate)
      if (c && c[1].length >= ticks) {
        close = j
        closeEnd = Math.min(at, text.length)
        break
      }
    }
    if (close === -1) break
    // AN INDENTED FENCE GIVES ITS INDENT BACK (CommonMark: up to the opener's indentation comes off every
    // content line). A fence written inside a list item sits at the item's content column, body and all,
    // and read with that indent left on, every key was "indented under nothing" and the fence had "no
    // `id:`" — a correction that named nothing the worker could see wrong.
    const dedent = new RegExp(`^ {0,${m[1].length}}`)
    const body = lines.slice(i + 1, close).map((l) => l.replace(/\r$/, "").replace(dedent, "")).join("\n")
    out.push({ start: lineStart, end: closeEnd, body, read: readQuestionFence(body) })
    // Resume after the closer; the offsets of the skipped lines are already counted in closeEnd.
    offset = closeEnd
    i = close
  }
  return out
}

// ── The front matter reader ────────────────────────────────────────────────────────────────────────────

interface Value {
  /** The value on the key's own line, trimmed (still quoted, if it was). */
  inline: string
  /** Indented lines under the key, dedented — a block scalar, or a continuation of the inline value. */
  block: string[]
}

// `s`: a value is everything to the end of its LINE, and the body is split on "\n" alone — so a lone CR or
// a U+2028 inside a value is part of it (a bare `.` stops at both, and the line then read as "not a key").
const KEY_RE = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*))?[ \t]*$/s
const BLOCK_MARKERS = new Set(["|", "|-", "|+", ">", ">-", ">+"])

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** Lines under a key: everything blank or indented deeper than `keyIndent`, dedented to their own margin. */
function collectBlock(lines: readonly string[], from: number, keyIndent: number): { block: string[]; next: number } {
  let j = from
  while (j < lines.length && (lines[j].trim() === "" || indentOf(lines[j]) > keyIndent)) j++
  const raw = lines.slice(from, j)
  while (raw.length && raw[raw.length - 1].trim() === "") raw.pop()
  // Trailing blank lines belong to whatever comes next, not to this value.
  let next = j
  while (next > from && lines[next - 1].trim() === "" && next - 1 >= from + raw.length) next--
  const margin = Math.min(...raw.filter((l) => l.trim()).map(indentOf), Number.POSITIVE_INFINITY)
  const block = raw.map((l) => (l.trim() ? l.slice(Number.isFinite(margin) ? margin : 0) : ""))
  return { block, next: Math.max(next, from) }
}

/** A value as ONE line of prose: the inline text and any continuation joined by single spaces. Collapsed
 *  again AFTER unquoting, because a quoted scalar's escapes are whitespace too: `"First\nsecond"` is two
 *  lines once read, and a question is what a one-line reading restates. */
function lineOf(v: Value): string {
  if (BLOCK_MARKERS.has(v.inline)) return v.block.join(" ").replace(/\s+/g, " ").trim()
  return unquote([v.inline, ...v.block].join(" ").replace(/\s+/g, " ").trim()).replace(/\s+/g, " ").trim()
}

/** The fence run (``` or ~~~~) of a code block this markdown opens and never closes, if it leaves one open.
 *  An unclosed fence runs to the end of its text, so it is the one whose interior ends there (a closed one
 *  ends at its closing line, which has characters of its own). */
function openFenceIn(markdown: string): string | undefined {
  const last = fencedInteriors(markdown).at(-1)
  if (!last || last[1] !== markdown.length) return undefined
  const opener = markdown.slice(0, last[0]).trimEnd().split("\n").at(-1) ?? ""
  return /^ {0,3}(`{3,}|~{3,})/.exec(opener)?.[1]
}

// WHY AN OPEN CODE BLOCK IS REFUSED. It is the mark of a fence that closed early: the closing ``` of a code
// block written inside a ```question fence is, to every markdown reader, the fence's own closer. The
// question then registered with its context cut off mid-block, and everything the worker wrote after it —
// the rest of the context, then the real closer, which now OPENS a block — rendered as code to the end of
// the message, a later ```question fence included, which registered nothing and was told nothing. Nothing
// else about the first fence is wrong, so this is named here or it is never named. (A real Haiku reply and
// a two-question probe both did it on the first day, 2026-10-13.)
//
// A ~~~ block cannot close a backtick fence, so one left open is only what it looks like.
function openFenceFault(where: string, run: string): string {
  if (run[0] === "~") return `${where} ends inside a ${run} code block that is never closed — close it with ${run} on a line of its own`
  const longer = "`".repeat(run.length + 1)
  return (
    `${where} ends inside an unclosed ${run} code block. If you did close it, that closing line closed this question fence instead — ` +
    "a fence ends at the first bare run of backticks as long as its own — and everything after it in your message, a later question fence included, reads as code. " +
    `Give the question fence more backticks than the block inside it: open it with ${longer}question and close it with ${longer}`
  )
}

/** A value as MARKDOWN: a block keeps its lines; an inline value with continuations joins them. */
function markdownOf(v: Value): string {
  if (BLOCK_MARKERS.has(v.inline) || (v.inline === "" && v.block.length > 0)) return v.block.join("\n").trim()
  return lineOf(v)
}

/** A worker writes YAML out of habit, so a value often arrives as one quoted scalar. Unwrap exactly that —
 *  escapes and `''` included — and leave anything that merely starts and ends on a quote as written. */
function unquote(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
    try {
      const parsed = parseYaml(value)
      if (typeof parsed === "string") return parsed.trim()
    } catch {
      // not one quoted scalar: the quotes are the worker's prose
    }
  }
  return value
}

function booleanOf(v: Value, key: string, faults: string[], where = ""): boolean | undefined {
  const s = lineOf(v).toLowerCase()
  if (s === "true" || s === "yes") return true
  if (s === "false" || s === "no" || s === "") return false
  faults.push(`${where}\`${key}: ${lineOf(v)}\` — write \`${key}: true\` or leave the key out`)
  return undefined
}

interface Frontmatter {
  keys: Map<string, Value>
  options: Map<string, Value>[] | undefined
  faults: string[]
}

function readFrontmatter(lines: readonly string[]): Frontmatter {
  const keys = new Map<string, Value>()
  let options: Map<string, Value>[] | undefined
  const faults: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === "") {
      i++
      continue
    }
    const m = indentOf(line) === 0 ? KEY_RE.exec(line) : null
    if (!m) {
      faults.push(
        indentOf(line) > 0
          ? `\`${line.trim()}\` is indented under nothing — only \`options:\` takes an indented list`
          : `\`${line.trim()}\` is not a key — context for the human goes below a \`---\` line`,
      )
      i++
      continue
    }
    const key = m[1].toLowerCase()
    const inline = (m[2] ?? "").trim()
    if (!(QUESTION_FENCE_KEYS as readonly string[]).includes(key)) {
      faults.push(`unknown key \`${m[1]}:\` — the keys are ${QUESTION_FENCE_KEYS.map((k) => `\`${k}\``).join(", ")}`)
      i = collectBlock(lines, i + 1, 0).next
      continue
    }
    if (keys.has(key) || (key === "options" && options)) faults.push(`\`${key}:\` is written twice`)
    if (key === "options") {
      const read = readOptions(lines, i + 1, inline, faults)
      options = read.options
      i = read.next
      continue
    }
    const { block, next } = collectBlock(lines, i + 1, 0)
    keys.set(key, { inline, block })
    i = next
  }
  return { keys, options, faults }
}

/** The `options:` list: `- ` items, each a set of `key: value` lines (or a bare label), at any indent. */
function readOptions(
  lines: readonly string[],
  from: number,
  inline: string,
  faults: string[],
): { options: Map<string, Value>[]; next: number } {
  const options: Map<string, Value>[] = []
  if (inline && inline !== "[]") faults.push("`options:` takes a list on the lines below it — `  - label: …`")
  let i = from
  let dashIndent = -1
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === "") {
      i++
      continue
    }
    const item = /^(\s*)-(?:[ \t]+(.*))?$/s.exec(line)
    // The list ends at the first line that is neither an item nor indented under one — the next top key.
    if (!item) {
      if (indentOf(line) > 0 && dashIndent >= 0) {
        faults.push(`\`${line.trim()}\` under \`options:\` is not part of an option — each option opens with \`- \``)
        i++
        continue
      }
      break
    }
    const indent = item[1].length
    if (dashIndent === -1) dashIndent = indent
    if (indent !== dashIndent) {
      faults.push(`\`${line.trim()}\` is indented differently from the options above it`)
      i++
      continue
    }
    const option = new Map<string, Value>()
    options.push(option)
    const first = (item[2] ?? "").trim()
    // A KEY'S VALUE IS WHATEVER SITS DEEPER THAN THE KEY ITSELF, so each key is read against its OWN column —
    // the first one's is wherever the text after the dash starts. Reading every key against one assumed
    // column (dash + 2) folded `description:` into the label above it whenever the dash was followed by
    // more than one space.
    const readKey = (text: string, at: number, column: number): number => {
      const k = KEY_RE.exec(text)
      if (!k) return -1
      const key = k[1].toLowerCase()
      if (!(QUESTION_FENCE_OPTION_KEYS as readonly string[]).includes(key)) {
        faults.push(`option ${options.length}: unknown key \`${k[1]}:\` — an option's keys are ${QUESTION_FENCE_OPTION_KEYS.map((x) => `\`${x}\``).join(", ")}`)
        return collectBlock(lines, at, column).next
      }
      if (option.has(key)) faults.push(`option ${options.length}: \`${key}:\` is written twice`)
      const { block, next } = collectBlock(lines, at, column)
      option.set(key, { inline: (k[2] ?? "").trim(), block })
      return next
    }
    const isOptionKey = (text: string) => (QUESTION_FENCE_OPTION_KEYS as readonly string[]).includes(KEY_RE.exec(text)?.[1].toLowerCase() ?? "")
    i++
    if (first) {
      const next = KEY_RE.test(first) ? readKey(first, i, line.length - (item[2] ?? "").length) : -1
      if (next === -1) {
        // A BARE ITEM IS ITS LABEL — `- Keep the fixed sleep` — the short form a follow-up's options take.
        // A label that wraps continues on the lines under it, UP TO the first one that is an option key
        // or another item: those are read below as what they are. Taken as more label, `- SQLite` over
        // `description: …` became an option labelled "SQLite description: …", with nothing refused.
        const wrapped: string[] = []
        while (i < lines.length && (lines[i].trim() === "" || indentOf(lines[i]) > indent)) {
          const text = lines[i].trimStart()
          if (isOptionKey(text) || /^-(?:[ \t]|$)/.test(text)) break
          if (text) wrapped.push(text)
          i++
        }
        option.set("label", { inline: first, block: wrapped })
      } else i = next
    }
    // The item's remaining keys.
    while (i < lines.length) {
      const l = lines[i]
      if (l.trim() === "") {
        i++
        continue
      }
      if (indentOf(l) <= indent) break
      const text = l.trimStart()
      if (/^-(?:[ \t]|$)/.test(text)) {
        faults.push(`\`${l.trim()}\` is indented differently from the options above it`)
        i++
        continue
      }
      const next = readKey(text, i + 1, indentOf(l))
      if (next === -1) {
        faults.push(`option ${options.length}: \`${l.trim()}\` is not a key — an option's keys are ${QUESTION_FENCE_OPTION_KEYS.map((x) => `\`${x}\``).join(", ")}`)
        i++
        continue
      }
      i = next
    }
  }
  return { options, next: i }
}

/** Read ONE fence body. Pure: the same text always reads the same way, which is what lets the server match
 *  a fence it has seen before against the row it registered. */
export function readQuestionFence(body: string): QuestionFenceRead {
  const lines = body.split("\n").map((l) => l.replace(/\r$/, ""))
  // The FIRST unindented `---` ends the front matter; a later one is a horizontal rule in the body, and an
  // indented one belongs to a `detail: |` block.
  const delimiter = lines.findIndex((l) => /^---+[ \t]*$/.test(l))
  const front = delimiter === -1 ? lines : lines.slice(0, delimiter)
  const context = delimiter === -1 ? "" : lines.slice(delimiter + 1).join("\n").trim()
  // FRONT MATTER WRAPPED IN `---` LINES, the way a markdown file's is. The first one then ends front matter
  // that never began, every key lands in the context, and the faults that would follow ("no `id:`", "no
  // `kind:`") deny what the worker can see on the page. Named for what it is instead, and alone.
  if (delimiter !== -1 && front.every((l) => l.trim() === "")) {
    return { form: "invalid", faults: ["the fence opens with `---` — its keys start on the first line, and the one `---` goes BELOW them, before the context"] }
  }
  const fm = readFrontmatter(front)
  const faults = [...fm.faults]

  const idValue = fm.keys.get("id")
  const rawId = idValue ? lineOf(idValue) : ""
  const id = rawId.toLowerCase()
  if (!idValue || !rawId) faults.unshift("no `id:` — every question fence opens with one, a slug of your choosing (`id: settings-store`)")
  else if (!ID_RE.test(id)) faults.unshift(`\`id: ${rawId}\` — an id is a slug: lowercase letters, digits, \`-\`, \`_\` or \`.\`, up to 64 characters`)
  const idOk = Boolean(idValue && rawId && ID_RE.test(id))

  // A REFERENCE: the id and nothing else. A body under it means the worker meant to ask.
  const others = [...fm.keys.keys()].filter((k) => k !== "id")
  if (others.length === 0 && !fm.options && !context) {
    if (faults.length > 0) return { form: "invalid", ...(idOk ? { id } : {}), faults }
    return { form: "ref", id }
  }

  if (idOk && id.startsWith(RESERVED_QUESTION_ID_PREFIX)) {
    faults.push(`\`${RESERVED_QUESTION_ID_PREFIX}\` ids are reserved for questions \`frizzctl ask\` registered — choose your own slug for a new question`)
  }
  const kindValue = fm.keys.get("kind")
  const kindRaw = kindValue ? lineOf(kindValue).toLowerCase() : ""
  const kind = (QUESTION_FENCE_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as QuestionFenceKind) : undefined
  if (!kindValue || !kindRaw) faults.push(`no \`kind:\` — one of ${QUESTION_FENCE_KINDS.map((k) => `\`${k}\``).join(", ")}`)
  else if (!kind) faults.push(`\`kind: ${kindRaw}\` — the kinds are ${QUESTION_FENCE_KINDS.map((k) => `\`${k}\``).join(", ")}`)

  const questionValue = fm.keys.get("question")
  const question = questionValue ? lineOf(questionValue) : ""
  if (!question) faults.push("no `question:` — one line, the question itself; anything longer goes below the `---`")
  else if (question.length > QUESTION_MAX) faults.push(`\`question:\` is ${question.length} characters; keep it to one line and put the rest below the \`---\``)
  if (context.length > CONTEXT_MAX) faults.push(`the body below \`---\` is ${context.length} characters; the limit is ${CONTEXT_MAX}`)
  const openInContext = openFenceIn(context)
  if (openInContext) faults.push(openFenceFault("the body below `---`", openInContext))

  const headerValue = fm.keys.get("header")
  const header = headerValue ? lineOf(headerValue) : undefined
  if (header && header.length > HEADER_MAX) faults.push(`\`header: ${header}\` is ${header.length} characters; a header is a chip of ${HEADER_MAX} at most`)
  const dangerValue = fm.keys.get("danger")
  const danger = dangerValue ? booleanOf(dangerValue, "danger", faults) : undefined

  let when: { parent: string; option: string } | undefined
  const whenValue = fm.keys.get("when")
  if (whenValue) {
    const raw = lineOf(whenValue)
    const eq = raw.indexOf("=")
    const parent = eq === -1 ? "" : raw.slice(0, eq).trim().toLowerCase()
    const option = eq === -1 ? "" : unquote(raw.slice(eq + 1).trim())
    if (!parent || !option || !ID_RE.test(parent)) faults.push(`\`when: ${raw}\` — write the parent's id and the option that opens this one: \`when: settings-store = SQLite\``)
    else when = { parent, option }
  }

  const options: AskedOption[] = []
  for (const [n, o] of (fm.options ?? []).entries()) {
    const where = `option ${n + 1}: `
    const labelValue = o.get("label")
    const label = labelValue ? lineOf(labelValue) : ""
    if (!label) {
      faults.push(`${where}no \`label:\``)
      continue
    }
    if (label.length > LABEL_MAX) faults.push(`${where}the label is ${label.length} characters; keep it under ${LABEL_MAX} and put the rest in \`description:\``)
    const description = o.get("description")
    const detail = o.get("detail")
    // ONE STORED FIELD: the card draws a one-line description inline after the label and anything longer
    // as markdown inside the option, so a detail rides the description's second paragraph.
    const parts = [description ? markdownOf(description) : "", detail ? markdownOf(detail) : ""].filter(Boolean)
    const text = parts.join("\n\n")
    if (text.length > DESCRIPTION_MAX) faults.push(`${where}the description and detail run ${text.length} characters; the limit is ${DESCRIPTION_MAX}`)
    const openInOption = openFenceIn(text)
    if (openInOption) faults.push(openFenceFault(`${where}its detail`, openInOption))
    const recommendedValue = o.get("recommended")
    const recommended = recommendedValue ? booleanOf(recommendedValue, "recommended", faults, where) : undefined
    options.push({ label, ...(text ? { description: text } : {}), ...(recommended ? { recommended: true } : {}) })
  }

  const labels = new Set<string>()
  for (const o of options) {
    const key = o.label.toLowerCase()
    if (labels.has(key)) faults.push(`two options are labelled \`${o.label}\` — labels must differ, the answer names the one picked`)
    labels.add(key)
  }
  if (kind === "choice" || kind === "multi") {
    if (options.length < 2) faults.push(`\`kind: ${kind}\` needs two or more options under \`options:\``)
    if (kind === "choice" && options.filter((o) => o.recommended).length > 1) {
      faults.push("only ONE option may be `recommended: true` on a `choice` — on two of three it says nothing (a `multi` may mark every option worth ticking)")
    }
  }
  if ((kind === "text" || kind === "secret") && fm.options) faults.push(`\`kind: ${kind}\` takes no options — it is ${kind === "secret" ? "one masked box" : "a free-text answer"}`)
  if (kind === "secret" && when) faults.push("a `secret` cannot be a follow-up — its answer would ride inside its parent's, unmasked")

  if (faults.length > 0 || !kind) return { form: "invalid", ...(idOk ? { id } : {}), faults }
  const spec: AskedQuestion = {
    handle: id,
    question,
    ...(context ? { context } : {}),
    ...(header ? { header } : {}),
    kind: kind === "multi" ? "multi" : "question",
    ...(danger ? { danger: true } : {}),
    ...(kind === "secret" ? { secret: true } : {}),
    ...(options.length > 0 ? { options } : {}),
  }
  return { form: "ask", id, spec, ...(when ? { when } : {}) }
}

// ── A message's fences, assembled ──────────────────────────────────────────────────────────────────────

export interface QuestionFenceFault {
  /** The fence's id, when it had a readable one. */
  id?: string
  faults: string[]
}

export interface AssembledQuestionFences {
  /** Root questions to register, follow-ups attached, in the order written. */
  asks: { id: string; spec: AskedQuestion }[]
  /** Ids named by a reference fence, in the order written. */
  refs: string[]
  /** Every fence that cannot register, with its reasons. */
  faults: QuestionFenceFault[]
}

/** One message's fences as what they ask for. A follow-up (`when:`) is attached to its parent's option
 *  here, so it must sit in the SAME message as its parent: the parent's card is registered as one tree,
 *  and a branch added after the human could already see the card would open under an answer in progress. */
export function assembleQuestionFences(reads: readonly QuestionFenceRead[]): AssembledQuestionFences {
  const out: AssembledQuestionFences = { asks: [], refs: [], faults: [] }
  const asks = new Map<string, { spec: AskedQuestion; when?: { parent: string; option: string } }>()
  for (const r of reads) {
    if (r.form === "invalid") out.faults.push({ ...(r.id ? { id: r.id } : {}), faults: r.faults })
    else if (r.form === "ref") {
      if (!out.refs.includes(r.id)) out.refs.push(r.id)
    } else if (asks.has(r.id)) {
      // The same fence written twice in one message is a restatement; two different ones are a collision —
      // and where it hangs is part of what it is: one id under two parents is two follow-ups.
      const seen = asks.get(r.id)
      if (JSON.stringify([seen?.spec, seen?.when ?? null]) !== JSON.stringify([r.spec, r.when ?? null])) out.faults.push({ id: r.id, faults: [`two different questions in this message use \`id: ${r.id}\``] })
    } else asks.set(r.id, { spec: r.spec, ...(r.when ? { when: r.when } : {}) })
  }
  // Attach every follow-up to its parent. A copy of each spec, so attaching never mutates a read the
  // caller still holds.
  const specs = new Map([...asks].map(([id, a]) => [id, structuredClone(a.spec)]))
  const failed = new Set<string>()
  for (const [id, a] of asks) {
    if (!a.when) continue
    const parent = specs.get(a.when.parent)
    const fail = (fault: string) => {
      failed.add(id)
      out.faults.push({ id, faults: [fault] })
    }
    if (!parent) {
      fail(`\`when: ${a.when.parent} = ${a.when.option}\` names no question in this message — a follow-up is written in the same message as the question it follows`)
      continue
    }
    if (parent.kind === "multi") {
      fail(`\`${a.when.parent}\` is a \`multi\`, and a multi's options cannot open follow-ups — several picks would open several at once`)
      continue
    }
    const option = parent.options?.find((o) => o.label.toLowerCase() === a.when!.option.toLowerCase())
    if (!option) {
      const labels = (parent.options ?? []).map((o) => `\`${o.label}\``).join(", ")
      fail(`\`when:\` names the option \`${a.when.option}\`, and \`${a.when.parent}\` has ${labels ? `only ${labels}` : "no options"}`)
      continue
    }
    option.followUps = [...(option.followUps ?? []), specs.get(id)!]
  }
  // A FOLLOW-UP THAT NEVER REACHES A ROOT REGISTERS NOTHING, so it is told why. Only a root registers, with
  // its tree. A follow-up whose chain of `when:` parents ends at one that failed goes down with it, and one
  // whose chain never ends — its own follow-up, or two that follow each other — hangs off nothing at all.
  // Neither was ever a root or a failure, so before this check both vanished without a word: no row, no
  // card (the web draws a follow-up inside its parent's), and no correction. Walked up the `when:` chain
  // rather than down the attached tree, because a loop's tree is circular.
  for (const [id, a] of asks) {
    if (!a.when || failed.has(id)) continue
    const walked = new Set([id])
    let at = a.when.parent
    while (!walked.has(at) && !failed.has(at) && asks.get(at)?.when) {
      walked.add(at)
      at = asks.get(at)!.when!.parent
    }
    if (failed.has(at)) out.faults.push({ id, faults: [`\`when: ${a.when.parent} = ${a.when.option}\` hangs this question off \`${at}\`, which could not register — it goes with it, so write both again`] })
    else if (at === id && walked.size === 1) out.faults.push({ id, faults: [`\`when: ${a.when.parent} = ${a.when.option}\` makes this question a follow-up of itself — \`when:\` names the EARLIER question whose option opens this one`] })
    else if (walked.has(at)) out.faults.push({ id, faults: [`\`when: ${a.when.parent} = ${a.when.option}\` is part of a loop of follow-ups (${[...walked].map((w) => `\`${w}\``).join(" → ")} → \`${at}\`) — one of them has to be a question with no \`when:\``] })
  }
  // A failed follow-up takes its own subtree with it, but never its parent: the parent stands on its own.
  for (const [id, a] of asks) {
    if (a.when || failed.has(id)) continue
    const spec = specs.get(id)!
    const treeFaults = askedQuestionFaults(spec)
    if (treeFaults.length > 0) out.faults.push({ id, faults: treeFaults })
    else out.asks.push({ id, spec })
  }
  return out
}

/** Every question fence in a message, read and assembled — the server's one entry point. */
export function questionFencesIn(text: string): AssembledQuestionFences {
  return assembleQuestionFences(questionFenceBlocks(text).map((b) => b.read))
}

/** Every handle a question tree carries — its root and every follow-up — so an id is never used twice in
 *  one thread, whichever node of a tree first claimed it. */
export function questionHandles(spec: AskedQuestion): string[] {
  const out: string[] = []
  const walk = (q: AskedQuestion) => {
    if (q.handle) out.push(q.handle)
    for (const o of q.options ?? []) for (const f of o.followUps ?? []) walk(f)
  }
  walk(spec)
  return out
}
