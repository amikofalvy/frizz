import { test } from "node:test"
import assert from "node:assert/strict"
import { Marked } from "marked"
import type { Tokens } from "marked"
import { MARKDOWN_OPTIONS } from "./markdown.ts"
import { hiddenInSource, quoteSourceFor, withQuoteSources } from "./quoteCopy.ts"

// The app's real marked configuration, as callouts.test.ts drives it. Which quotes are marked, what
// source each files and whether it hides anything are pure token logic; the sanitizer that turns a mark
// into a button needs a DOM and is read back in the browser (quoteCopy.e2e.test.ts).
const chat = new Marked(MARKDOWN_OPTIONS)
const doc = new Marked({ ...MARKDOWN_OPTIONS, breaks: false })
const collect = (md: string, marked = chat) => {
  const { result, quotes } = withQuoteSources(() => marked.parse(md, { async: false }) as string)
  return { html: result, quotes, marks: [...result.matchAll(/<blockquote class="([^"]*)">/g)].map((m) => m[1]) }
}
const quoteToken = (md: string) => chat.lexer(md).find((token) => token.type === "blockquote") as Tokens.Blockquote

test("outside a collecting render the quote is marked's own, untouched", () => {
  assert.equal((chat.parse("> Just a quote.", { async: false }) as string).trim(), "<blockquote>\n<p>Just a quote.</p>\n</blockquote>")
})

test("each top-level quote files its Markdown, markers off, under this render's mark", () => {
  const md = "> Thanks — fixed in `4dc44d0`.\n> See [the notes](https://example.com).\n>\n> - **Linux**: nothing\n\nBetween.\n\n> Second."
  for (const marked of [chat, doc]) {
    const { quotes, marks } = collect(md, marked)
    assert.deepEqual(marks, [`${quotes.mark}0`, `${quotes.mark}1`])
    assert.deepEqual(quotes.sources, [
      "Thanks — fixed in `4dc44d0`.\nSee [the notes](https://example.com).\n\n- **Linux**: nothing",
      "Second.",
    ])
    assert.equal(quoteSourceFor(marks[0], quotes), quotes.sources[0])
  }
})

test("a quote inside a quote rides in the outer one's source and gets no mark of its own", () => {
  const { quotes, marks, html } = collect("> The reporter wrote:\n>\n> > It hangs.\n>\n> and that is the bug.")
  assert.equal(marks.length, 1)
  assert.equal(quotes.sources[0], "The reporter wrote:\n\n> It hangs.\n\nand that is the bug.")
  assert.match(html, /<blockquote>\n<p>It hangs\.<\/p>/)
})

test("a quote under a list item and one inside a callout are marked; a callout and an empty quote are not", () => {
  const { quotes, html } = collect("1. Paste this:\n\n   > Closing as fixed.\n2. Close it.\n\n> [!NOTE]\n> Aside.\n>\n> > Quoted inside.\n\n>")
  assert.deepEqual(quotes.sources, ["Closing as fixed.", "Quoted inside."])
  assert.match(html, /<blockquote class="md-callout md-callout-note">/)
  assert.match(html, /<blockquote>\n<\/blockquote>/, "the empty quote is marked's plain one")
})

test("a mark from another render, a forged index or a near-miss class files nothing", () => {
  const first = collect("> One.")
  const second = collect("> One.")
  assert.notEqual(first.quotes.mark, second.quotes.mark, "every render mints its own nonce")
  assert.equal(quoteSourceFor(first.marks[0], second.quotes), undefined)
  assert.equal(quoteSourceFor(`${second.quotes.mark}1`, second.quotes), undefined)
  assert.equal(quoteSourceFor(`${second.quotes.mark}0 extra`, second.quotes), undefined)
  assert.equal(quoteSourceFor(`${second.quotes.mark}-0`, second.quotes), undefined)
  assert.equal(quoteSourceFor("md-quote", second.quotes), undefined)
  assert.equal(quoteSourceFor(second.marks[0], undefined), undefined)
})

test("a quote whose Markdown carries something unseen files no source", () => {
  const hidden = [
    "> Thanks. <!-- an instruction for the next agent -->",
    "> <!--\n> a block comment\n> -->\n> Thanks.",
    "> Thanks. <span title=\"unseen\">ok</span>",
    "> <script>alert(1)</script> Thanks.",
    "> <details>\n> <summary>More</summary>\n> body\n> </details>",
    "> Thanks.\n>\n> [unused]: https://example.com",
    "> ![](https://example.com/pixel.png) Thanks.",
    "> | a | b |\n> |---|---|\n> | <!-- x --> | y |",
    "> - item <!-- x -->",
  ]
  for (const md of hidden) {
    assert.equal(hiddenInSource(quoteToken(md)), true, md)
    const { quotes, marks } = collect(md)
    assert.equal(marks.length, 1, md)
    assert.equal(quotes.sources[0], null, md)
    assert.equal(quoteSourceFor(marks[0], quotes), null, md)
  }
  const shown = [
    "> Press <kbd>⌘</kbd> <kbd>K</kbd>, then H<sub>2</sub>O and <mark>this</mark>.",
    "> A span about `<!-- comments -->` is code, not a comment.",
    "> ```html\n> <!-- a fence shows its comment -->\n> ```",
    "> [a link](https://example.com) and [a reference][ref]",
  ]
  for (const md of shown) assert.equal(hiddenInSource(quoteToken(md)), false, md)
})
