import { test } from "node:test"
import assert from "node:assert/strict"
import { AWAITING_TITLE_MAX, awaitingFenceTitle, splitDoneFrontmatter } from "./index.ts"

// A DONE FENCE'S `title:` (2026-10-13): the card's heading, in the worker's own words, as the same
// `{ kind: "title" }` hint an awaiting fence's `title:` makes. The grammar is narrow on purpose — a done
// body is a Markdown ledger first, and every one written before this date has no frontmatter — so these
// pin both what is read and, as hard, what is left alone.

test("a leading title: and its --- become the hint; the ledger below is the body", () => {
  const { hints, body } = splitDoneFrontmatter("title: Resolver cache keyed on the normalized id\n---\n- **Fixed** the lookup.\n- Added a test.")
  assert.deepEqual(hints, [{ kind: "title", value: "Resolver cache keyed on the normalized id" }])
  assert.equal(body, "- **Fixed** the lookup.\n- Added a test.")
  assert.equal(awaitingFenceTitle(hints), "Resolver cache keyed on the normalized id", "the card reads it the way it reads an awaiting title")
})

test("the --- is optional, and blank lines around the title are tolerated", () => {
  assert.deepEqual(splitDoneFrontmatter("title: Landed the fix\n- **Fixed** it."), {
    body: "- **Fixed** it.",
    hints: [{ kind: "title", value: "Landed the fix" }],
  })
  assert.deepEqual(splitDoneFrontmatter("\n\nTITLE: Landed the fix\n\n---\n\n- **Fixed** it.\n"), {
    body: "- **Fixed** it.",
    hints: [{ kind: "title", value: "Landed the fix" }],
  })
})

test("indented lines under the title continue it, joined onto one line", () => {
  const { hints, body } = splitDoneFrontmatter("title: Resolver cache keyed\n  on the normalized id\n\tand tested\n---\nBody.")
  assert.deepEqual(hints, [{ kind: "title", value: "Resolver cache keyed on the normalized id and tested" }])
  assert.equal(body, "Body.")
})

test("a body with no title is returned whole — a --- in it is a horizontal rule, not a delimiter", () => {
  const raw = "  \nShipped the fix.\n\n---\n\n- **Fixed** it.\n  "
  assert.deepEqual(splitDoneFrontmatter(raw), { body: "Shipped the fix.\n\n---\n\n- **Fixed** it.", hints: [] })
  assert.deepEqual(splitDoneFrontmatter("---\n- **Fixed** it."), { body: "---\n- **Fixed** it.", hints: [] })
  assert.deepEqual(splitDoneFrontmatter(""), { body: "", hints: [] })
})

test("a title: line below the first is prose, and no other key is honoured", () => {
  const mid = "Landed it.\ntitle: not a heading here\n---\nmore"
  assert.deepEqual(splitDoneFrontmatter(mid), { body: mid, hints: [] })
  // An awaiting key on a done fence is prose: nothing on a done fence parks, and YAML never runs on it.
  const other = "prs: [acme/app#1]\ntitle: Landed\n---\nBody."
  assert.deepEqual(splitDoneFrontmatter(other), { body: other, hints: [] })
  // `title` must be the WHOLE key: `titles:` and `subtitle:` are someone's sentence.
  assert.deepEqual(splitDoneFrontmatter("titles: three of them\nBody.").hints, [])
  assert.deepEqual(splitDoneFrontmatter("Subtitle: it\nBody.").hints, [])
})

test("an empty title mints no hint, and its line still never reaches the body", () => {
  assert.deepEqual(splitDoneFrontmatter("title:\n---\n- **Fixed** it."), { body: "- **Fixed** it.", hints: [] })
  assert.deepEqual(splitDoneFrontmatter("title:   \n- **Fixed** it."), { body: "- **Fixed** it.", hints: [] })
  assert.deepEqual(splitDoneFrontmatter("title: x\n---"), { body: "", hints: [{ kind: "title", value: "x" }] })
})

test("the title is prose, not YAML: a # and a colon survive whole", () => {
  assert.deepEqual(splitDoneFrontmatter("title: Fixed acme/app#64172: the resolver cache\n---\nBody.").hints, [
    { kind: "title", value: "Fixed acme/app#64172: the resolver cache" },
  ])
})

test("a paragraph-length title is cut to the awaiting cap on a word boundary", () => {
  const long = "Rewrote the resolver cache so it keys on the normalized id, added a regression test for the collision, and landed both on main after the full suite"
  const title = splitDoneFrontmatter(`title: ${long}\n---\nBody.`).hints[0]!.value
  assert.ok(title.length <= AWAITING_TITLE_MAX + 1, `${title.length} characters`)
  assert.ok(title.endsWith("…"))
  assert.ok(long.startsWith(title.slice(0, -1)), "cut on the worker's own words")
  const whole = "x".repeat(AWAITING_TITLE_MAX)
  assert.equal(splitDoneFrontmatter(`title: ${whole}`).hints[0]!.value, whole, "a title at the cap survives whole")
})

test("CRLF line endings parse like LF", () => {
  assert.deepEqual(splitDoneFrontmatter("title: Landed\r\n---\r\n- Fixed.\r\n"), { body: "- Fixed.", hints: [{ kind: "title", value: "Landed" }] })
})
