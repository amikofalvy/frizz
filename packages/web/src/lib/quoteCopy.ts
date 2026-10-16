// A COPY BUTTON ON EVERY BLOCKQUOTE, copying the quote's own Markdown with the `>` markers taken off —
// the source the author wrote, not the rendered text. A quote in a worker's message is most often a
// drafted reply, a comment or a release note on its way somewhere else, and that destination (a GitHub
// comment, a PR body, a commit message) reads Markdown: copying the rendered text instead dropped every
// backtick and every link target on the way.
//
// WHAT IS COPIED IS STILL ONLY WHAT IS SHOWN. A code block's button copies the `<code>` beside it, so
// the clipboard can never hold something the reader did not see; the prose is only semi-trusted, and a
// quote's button must keep that promise while copying text that is NOT in the visible DOM. Two halves:
//
// - THE SOURCE CANNOT BE FORGED. It rides on the button as an attribute, and marked passes raw HTML
//   through, so an author who could write that attribute could show one thing and copy another. It is
//   never admitted from the HTML. The renderer below files each quote's source in a table that lives
//   for one render and marks the quote with a class carrying that render's random nonce; the sanitizer
//   (markdown.ts) honours only a mark with the live nonce, takes the source from the table and mints the
//   button itself, AFTER its allowlist pass — the way markdown.ts's frameImage mints its frame. Nothing
//   an author writes can name a nonce minted after they wrote it.
// - THE SOURCE HIDES NOTHING. Markdown can carry text no reader sees: an HTML comment, a tag the
//   sanitizer drops with its content, an attribute, a link reference definition, a remote image. Pasted
//   into a GitHub comment, all of it posts under the reader's name, invisible there too. A quote whose
//   source holds any of those is copied as its VISIBLE text instead (`hiddenInSource`), which is what
//   selecting it and pressing copy would have taken.
//
// Not on a callout (lib/callouts.ts): a `> [!WARNING]` is the author's labelled aside, read in place,
// and renders through its own extension. Not on a quote INSIDE another quote either: the outer quote's
// button already copies it, `>` markers and all, and two buttons lit by one hover would be one too many.

import type { Token, Tokens } from "marked"

export const QUOTE_CLASS = "md-quote"
export const QUOTE_COPY_CLASS = "md-quote-copy"
export const COPY_QUOTE_LABEL = "Copy quote"
/** The minted button's attribute holding the quote's Markdown. */
export const QUOTE_SOURCE_ATTR = "data-md-source"

export type QuoteSources = { mark: string; sources: (string | null)[]; depth: number }

// The render in progress's table, or null outside `withQuoteSources` — under `node --test` and on any
// path that never sanitizes, where the renderer below steps aside and marked draws a plain quote.
let pending: QuoteSources | null = null

/** Run one render with a fresh quote table, and hand the table back with its output. */
export function withQuoteSources<T>(render: () => T): { result: T; quotes: QuoteSources } {
  const before = pending
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")
  const quotes: QuoteSources = { mark: `${QUOTE_CLASS}-src-${nonce}-`, sources: [], depth: 0 }
  pending = quotes
  try {
    return { result: render(), quotes }
  } finally {
    pending = before
  }
}

/**
 * What a quote's class files it under: undefined when the class is not this render's mark (an ordinary
 * quote, or one an author wrote in HTML), else its source — or null for one copied as its visible text.
 */
export function quoteSourceFor(className: string, quotes: QuoteSources | undefined): string | null | undefined {
  if (!quotes || !className.startsWith(quotes.mark)) return undefined
  const index = className.slice(quotes.mark.length)
  return /^\d+$/.test(index) && Number(index) < quotes.sources.length ? quotes.sources[Number(index)] : undefined
}

// The raw tags a quote may carry and still be copied as Markdown: inline marks that draw their content
// where it stands, written bare. An allowlist, not the sanitizer's drop list, so a tag nobody thought
// about falls on the safe side — any other tag, any attribute, a comment or a declaration is something
// the reader may not see.
const SHOWN_TAG = /^<\/?(?:kbd|sub|sup|mark|br|strong|em|del|code)\s*\/?>$/i
// A link reference definition line (`[id]: https://…`). marked files those away from the token tree
// entirely, so the quote's text is the only place left to see one.
const DEFINITION = /^ {0,3}\[(?:[^\]\\]|\\.)+\]:/m

/** Whether a quote's Markdown carries anything its rendering may not show. */
export function hiddenInSource(token: Tokens.Blockquote): boolean {
  return DEFINITION.test(token.text) || token.tokens.some(hides)
}

type Children = { tokens?: Token[]; items?: Token[]; header?: { tokens: Token[] }[]; rows?: { tokens: Token[] }[][] }

function hides(token: Token): boolean {
  if (token.type === "image") return true
  // A block of raw HTML holds text and tags together; every tag in it must be a shown one.
  if (token.type === "html") return (token.raw.match(/<[^>]*>?/g) ?? []).some((tag) => !SHOWN_TAG.test(tag))
  const { tokens = [], items = [], header = [], rows = [] } = token as Children
  return [...tokens, ...items, ...[...header, ...rows.flat()].flatMap((cell) => cell.tokens)].some(hides)
}

/**
 * Make a marked quote the copyable one: its class, and the button as its first child. A null source is a
 * quote copied as its visible text (`hiddenInSource`), so its button carries none.
 */
export function mintQuoteCopy(quote: Element, source: string | null): void {
  quote.setAttribute("class", QUOTE_CLASS)
  const button = quote.ownerDocument.createElement("button")
  button.type = "button"
  button.className = QUOTE_COPY_CLASS
  // `title` is the accessible name, as on the code block's button.
  button.title = COPY_QUOTE_LABEL
  if (source !== null) button.setAttribute(QUOTE_SOURCE_ATTR, source)
  // FIRST, because styles.css floats it: a float shortens only the lines beside it, so the quote's first
  // line makes room for the button and every line under it keeps the full measure.
  quote.prepend(button)
}

type RendererThis = { parser: { parse: (tokens: Token[]) => string } }

// marked's `blockquote` renderer. `false` hands the quote back to marked's own renderer — outside a
// collecting render, and for a quote inside one this render already marked.
export function renderBlockquote(this: RendererThis, token: Tokens.Blockquote): string | false {
  const quotes = pending
  // An empty `>` has nothing to copy.
  if (!quotes || quotes.depth > 0 || !token.text.trim()) return false
  quotes.depth++
  let body: string
  try {
    body = this.parser.parse(token.tokens)
  } finally {
    quotes.depth--
  }
  // `text` is the quote with its markers stripped, lazy continuation lines included — exactly what
  // marked tokenized as its body.
  const index = quotes.sources.push(hiddenInSource(token) ? null : token.text.replace(/\n+$/, "")) - 1
  return `<blockquote class="${quotes.mark}${index}">\n${body}</blockquote>\n`
}
