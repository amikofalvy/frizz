// Where a markdown text's fenced CODE BLOCKS are, so the scanners that hunt for frizz's own openers
// (```question, ```done, ```awaiting) can ignore the ones a message is merely QUOTING.
//
// Every one of those scanners is a line-anchored regex over raw markdown with no notion of nesting, so
// a worker that documents the protocol — the correct authoring form being a ````-wrapped example around
// a ```question sample — had its sample hoisted OUT into a live answerable card, while the enclosing
// ```` delimiters were left behind as orphan prose that opened an unterminated code block and swallowed
// the rest of the message. Same root cause for a quoted ```done/```awaiting.
//
// Shared (not mirrored by hand in each package) because the web renderer and the server's derived
// pending-question flag must agree about what is a real opener; a divergence here is a thread that
// renders one way and is CLASSIFIED another.

// The half-open character range [start, end) INSIDE one fenced code block — from the first character
// after the opening fence line to the first character of the closing fence line.
export type FenceInterior = readonly [start: number, end: number]

// A fence line: up to 3 leading spaces, then a run of 3+ backticks or tildes, then the info string.
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/

// WHAT OPENS A QUESTION FENCE — one definition, read by both scanners below and by the question reader
// (question-fence.ts), so they cannot disagree about which line is one.
//
// The contract teaches three backticks and a lowercase `question`, and that is all it teaches. This also
// takes what a markdown reader takes for the same block (2026-10-13, third round): a TILDE fence
// (`~~~question`), the info string in ANY CASE (`Question`, `QUESTION`), and spaces or tabs between the
// run and the word (CommonMark trims an info string). Each of those drew as a code block labelled
// `question`, registered nothing and earned no correction — the worker rested believing it had asked, and
// the human was shown nothing. Nobody writes one of them meaning anything else, so each is the fence.
// (`i` without `u`: only ASCII letters fold, so no look-alike spells the word.)
//
// What is still NOT a fence, on purpose: one inside a blockquote, one indented four or more spaces, and one
// inside another fence. Those are how a worker QUOTES a sample of the grammar. And an info string that
// carries anything after the word (```question qst_…, ```question multi) is the legacy grammar's.
const QUESTION_OPENER = /^( {0,3})(`{3,}|~{3,})[ \t]*question[ \t]*$/i

export interface QuestionFenceOpener {
  /** The opener's own indent, 0–3 spaces: it comes off every line of the body. */
  indent: number
  /** The character the fence is made of. Only a bare run of the SAME character closes it. */
  char: "`" | "~"
  /** The run's length. The closer is at least as long. */
  len: number
}

/** This line as a question fence's opener, or undefined when it is not one. A trailing CR is ignored. */
export function questionFenceOpener(line: string): QuestionFenceOpener | undefined {
  const m = QUESTION_OPENER.exec(line.replace(/\r$/, ""))
  return m ? { indent: m[1].length, char: m[2][0] as "`" | "~", len: m[2].length } : undefined
}

/** Could this text hold a question fence at all? The cheap test in front of every real scan — most messages
 *  carry no fence. It only ever errs toward "maybe": the scan decides. Every reader that gates on the
 *  opener asks this, so none of them can skip a fence the scan would have found (the web's gates were a
 *  literal three-backticks-and-lowercase match until a tilde fence could register). */
export function mayHoldQuestionFence(text: string): boolean {
  return /(?:`{3}|~{3})[ \t]*question/i.test(text)
}

// WHERE A ```question FENCE ENDS — the one place this file departs from CommonMark, on purpose (2026-10-13).
//
// A question fence's body is markdown, and markdown has code blocks. CommonMark ends a fence at the first
// bare run of backticks as long as its own, so a ```sql block inside a ```question fence closes the
// question at the SQL's closer; the contract therefore told workers to open the outer fence with four. A
// real model does not reliably do it: Haiku got the outer fence wrong in 4 of 6 runs across three rewordings
// of that instruction (three backticks outside and three on the inner block; three outside and FOUR inside).
// Read to the letter, each of those registered a question with its context cut off mid-block, and the
// question's real closer then OPENED a block that ran through the rest of the message — a second question,
// a ```done, an ```awaiting — as quoted code nobody was told about.
//
// So inside an open question fence, A FENCE LINE WITH AN INFO STRING OPENS A NESTED BLOCK (```sql, ````diff,
// ~~~ts): an info string cannot be a closer, so it can only be a block the worker meant to put there. The
// next BARE fence line of the same character, at least as long, closes that nested block and not the
// question; after it the search for the question's own closer goes on as before.
//
// What stays CommonMark: a nested opener with NO info string, made of the question's own character, is
// indistinguishable from the question's closer, so it closes the question; a line indented four or more
// spaces (an option's `detail: |` block) is no fence line at all; and nothing nests inside any other fence —
// a ````md sample quoting a question is read exactly as a renderer reads it.
//
// THE QUESTION'S OWN CHARACTER is what "its closer" means throughout: a backtick question is closed by
// backticks and a `~~~question` by tildes, each at least as long as the opener. A bare run of the OTHER
// character closes nothing and opens nothing here — it is a line of the body, as CommonMark has it — so a
// plain ``` block inside a tilde question is simply part of it.
//
// CUT SHORT. If no line closes the question under that reading but one does under CommonMark's — the
// worker closed its inner block and never the question — the fence ends at CommonMark's line and says so,
// and the reader refuses it by name (question-fence.ts). A fence with no bare closing line under either
// reading is unclosed and runs to the end of the text: a turn interrupted mid-fence, which is nobody's mistake.
export interface QuestionFenceClose {
  /** Index, in `lines`, of the line that closes the question fence. */
  close: number
  /** True when only CommonMark's reading closes it: the body ends inside a nested block. */
  cutShort: boolean
}

/** Where the question fence opened on the line before `from` ends. `ticks` is its opener's run length and
 *  `fence` the character it is made of; `lines` is the text split on "\n" (a trailing CR on a line is
 *  ignored). Undefined when it never closes. */
export function questionFenceClose(lines: readonly string[], from: number, ticks: number, fence: "`" | "~" = "`"): QuestionFenceClose | undefined {
  let nested: { char: string; len: number } | null = null
  let commonMark = -1
  for (let j = from; j < lines.length; j++) {
    const m = lines[j].replace(/\r$/, "").match(FENCE_LINE)
    if (!m) continue
    const char = m[1][0]
    const len = m[1].length
    const bare = m[2].trim() === ""
    if (commonMark === -1 && bare && char === fence && len >= ticks) commonMark = j
    if (nested) {
      if (bare && char === nested.char && len >= nested.len) nested = null
      continue
    }
    if (bare) {
      if (char === fence && len >= ticks) return { close: j, cutShort: false }
      continue
    }
    // A backtick fence's info string may not hold a backtick — such a line opens nothing.
    if (!(char === "`" && m[2].includes("`"))) nested = { char, len }
  }
  return commonMark === -1 ? undefined : { close: commonMark, cutShort: true }
}

// CommonMark, kept to the parts that matter here: a backtick fence's info string may not contain a
// backtick (that is what makes ```` ```question ```` a CLOSER-proof opener); a closing fence is a bare
// run of the SAME character, at least as long as the opener, with nothing else on the line. An
// unclosed fence runs to the end of the text — exactly how a renderer treats it. A ```question fence
// alone ends where `questionFenceClose` says, so every scanner built on this agrees with the question
// reader about what comes after one.
export function fencedInteriors(text: string): FenceInterior[] {
  const out: FenceInterior[] = []
  const lines = text.split("\n")
  const starts: number[] = []
  for (let i = 0, offset = 0; i < lines.length; i++) {
    starts.push(offset)
    offset += lines[i].length + 1 // the +1 is the "\n" the split consumed
  }
  const after = (i: number) => Math.min(starts[i] + lines[i].length + 1, text.length)
  let open: { char: string; len: number; from: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].replace(/\r$/, "").match(FENCE_LINE)
    if (open) {
      if (m && m[1][0] === open.char && m[1].length >= open.len && m[2].trim() === "") {
        out.push([open.from, starts[i]])
        open = null
      }
    } else if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      const question = questionFenceOpener(lines[i])
      if (question) {
        const end = questionFenceClose(lines, i + 1, question.len, question.char)
        if (!end) {
          out.push([after(i), text.length])
          return out
        }
        out.push([after(i), starts[end.close]])
        i = end.close
      } else open = { char: m[1][0], len: m[1].length, from: after(i) }
    }
  }
  if (open) out.push([open.from, text.length])
  return out
}

// A predicate over character offsets: true when that offset sits inside a fenced code block. Built once
// per text so a scanner can test every candidate opener without rescanning.
export function insideFence(text: string): (index: number) => boolean {
  const ranges = fencedInteriors(text)
  if (ranges.length === 0) return () => false
  return (index: number) => ranges.some(([start, end]) => index >= start && index < end)
}
