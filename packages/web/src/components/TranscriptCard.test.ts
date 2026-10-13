import assert from "node:assert/strict"
import test from "node:test"
import { createElement, type ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ListTodo } from "lucide-react"
import { TranscriptCard } from "./TranscriptCard.tsx"

// THE KIND HEAD (2026-10-13) — what every block type wears: a small line naming the card's kind, the title
// under it, a rule. Pinned here as STRUCTURE: which pieces a card draws and in what order. The spacing those
// pieces were measured for lives in their classes and is judged in a browser, where
// signalCardHeads.e2e.test.ts and AwaitingSteps.e2e.test.ts draw the real cards.
const html = (props: ComponentProps<typeof TranscriptCard>) => renderToStaticMarkup(createElement(TranscriptCard, props))
const at = (out: string, marker: string) => {
  const i = out.indexOf(marker)
  assert.notEqual(i, -1, `${marker} is drawn`)
  return i
}

test("a kind-headed card names its kind on a small line, puts the title under it, and rules the body off", () => {
  const out = html({ icon: ListTodo, kind: "Awaiting human", label: "Sign in to npm", children: "Run the login." })
  // The glyph LEADS the kind line, ahead of the word — not beside the title, as a plain head draws it.
  assert.match(out, /<span data-card-kind[^>]*><svg[^>]*lucide-list-todo[^>]*>.*?<\/svg><span[^>]*>Awaiting human<\/span><\/span>/)
  assert.doesNotMatch(out, /card-icon-offset/, "no title-row glyph beside the kind")
  // Kind, then the title on its own line, then the rule, then the body.
  const kind = at(out, "data-card-kind")
  const title = at(out, "data-card-title")
  const rule = at(out, "data-card-rule")
  const body = at(out, "Run the login.")
  assert.ok(kind < title && title < rule && rule < body, "kind → title → rule → body")
  assert.match(out, /data-card-title[^>]*>Sign in to npm</)
})

test("the kind alone can head the card, and a card with no body draws no rule", () => {
  // Untitled: the kind line already says what the card is for, so no empty title line is spent.
  const untitled = html({ icon: ListTodo, kind: "Awaiting human", label: null, children: "Run the login." })
  assert.doesNotMatch(untitled, /data-card-title/)
  assert.ok(at(untitled, "data-card-kind") < at(untitled, "data-card-rule"))
  // Bodiless: there is nothing to rule off.
  assert.doesNotMatch(html({ icon: ListTodo, kind: "Awaiting human", label: "Sign in to npm" }), /data-card-rule/)
})

test("a kind-headed card can decline its rule, and keeps its body", () => {
  // A bare ```done is its kind line and its action band: the band's own border is the seam, so a rule
  // above it would draw a second one around nothing.
  const out = html({ icon: ListTodo, kind: "Done", label: null, ruled: false, children: "Mark as done" })
  assert.doesNotMatch(out, /data-card-rule/)
  assert.match(out, /class="card-md mt-3\.5[^"]*">Mark as done</, "…and the band's border takes the rule's distance")
})

test("a tone colours the kind line, and the title stays the title's colour", () => {
  // A destructive question: the warning is said where the eye lands first, on the kind line, while the
  // title (when there is one) keeps full strength.
  const out = html({ tone: "risk", icon: ListTodo, kind: "Question", label: "Delete the branch?", children: "x" })
  assert.match(out, /<span data-card-kind[^>]*class="[^"]*text-danger/)
  assert.match(out, /data-card-title[^>]*class="[^"]*text-fg/)
  assert.match(html({ icon: ListTodo, kind: "Done", label: null, children: "x" }), /<span data-card-kind[^>]*class="[^"]*text-muted/, "neutral kinds are muted")
})

test("a card without a kind keeps the glyph-beside-title head", () => {
  const out = html({ icon: ListTodo, label: "Awaiting", children: "Waiting for an external update." })
  assert.doesNotMatch(out, /data-card-kind|data-card-rule|data-card-title/)
  assert.match(out, /<svg[^>]*card-icon-offset[^>]*>.*?<\/svg><span[^>]*>Awaiting<\/span>/)
})
