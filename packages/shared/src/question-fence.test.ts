import assert from "node:assert/strict"
import test from "node:test"
import { assembleQuestionFences, questionFenceBlocks, questionFencesIn, questionHandles, readQuestionFence } from "./question-fence.ts"

const fence = (body: string, ticks = "```") => `${ticks}question\n${body}\n${ticks}`

test("a choice question reads every field, and the body below --- is its context", () => {
  const r = readQuestionFence([
    "id: settings-store",
    "kind: choice",
    "question: Should the settings store use SQLite or a JSON file?",
    "options:",
    "  - label: SQLite",
    "    description: transactional, and one store to back up",
    "    recommended: true",
    "  - label: JSON file",
    "    description: no dependency, hand-editable",
    "---",
    "Settings are read on every request.",
    "",
    "| Store | Crash-safe |",
    "|---|---|",
    "| SQLite | yes |",
  ].join("\n"))
  assert.equal(r.form, "ask")
  if (r.form !== "ask") return
  assert.equal(r.id, "settings-store")
  assert.deepEqual(r.spec, {
    handle: "settings-store",
    question: "Should the settings store use SQLite or a JSON file?",
    context: "Settings are read on every request.\n\n| Store | Crash-safe |\n|---|---|\n| SQLite | yes |",
    kind: "question",
    options: [
      { label: "SQLite", description: "transactional, and one store to back up", recommended: true },
      { label: "JSON file", description: "no dependency, hand-editable" },
    ],
  })
})

test("values are prose read verbatim: colons, backticks and # survive, and a quoted value is unquoted", () => {
  const r = readQuestionFence([
    "id: npm-scope",
    "kind: choice",
    "question: Which scope: `@frizz` or `@frizzhq`? See #42",
    "options:",
    "  - label: `@frizzhq`",
    "    description: free today: claim it now # before someone else",
    '  - label: "Keep @frizz"',
  ].join("\n"))
  assert.equal(r.form, "ask")
  if (r.form !== "ask") return
  assert.equal(r.spec.question, "Which scope: `@frizz` or `@frizzhq`? See #42")
  assert.equal(r.spec.options?.[0].label, "`@frizzhq`")
  assert.equal(r.spec.options?.[0].description, "free today: claim it now # before someone else")
  assert.equal(r.spec.options?.[1].label, "Keep @frizz")
})

test("an option's detail block is kept as markdown, a nested code fence included, under a longer outer fence", () => {
  const text = fence([
    "id: retry-backoff",
    "kind: choice",
    "question: Which backoff should the flaky upload use?",
    "options:",
    "  - label: Exponential",
    "    description: doubles from 100ms, capped at five tries",
    "    recommended: true",
    "    detail: |",
    "      ```diff",
    "      -  await sleep(100)",
    "      +  await sleep(2 ** attempt * 100)",
    "      ```",
    "",
    "      Then a second paragraph.",
    "  - Keep the fixed sleep",
  ].join("\n"), "````")
  const blocks = questionFenceBlocks(text)
  assert.equal(blocks.length, 1)
  const r = blocks[0].read
  assert.equal(r.form, "ask")
  if (r.form !== "ask") return
  assert.equal(
    r.spec.options?.[0].description,
    "doubles from 100ms, capped at five tries\n\n```diff\n-  await sleep(100)\n+  await sleep(2 ** attempt * 100)\n```\n\nThen a second paragraph.",
  )
  // A BARE item is its label.
  assert.deepEqual(r.spec.options?.[1], { label: "Keep the fixed sleep" })
})

test("the four kinds map onto the stored shape, and each refuses the options it cannot take", () => {
  const multi = readQuestionFence("id: a\nkind: multi\nquestion: Which?\noptions:\n  - label: x\n    recommended: true\n  - label: y\n    recommended: true")
  assert.equal(multi.form === "ask" && multi.spec.kind, "multi")
  const text = readQuestionFence("id: b\nkind: text\nquestion: What scope?")
  assert.deepEqual(text.form === "ask" && text.spec, { handle: "b", question: "What scope?", kind: "question" })
  const secret = readQuestionFence("id: otp\nkind: secret\nquestion: The npm one-time code")
  assert.deepEqual(secret.form === "ask" && secret.spec, { handle: "otp", question: "The npm one-time code", kind: "question", secret: true })

  const textWithOptions = readQuestionFence("id: c\nkind: text\nquestion: Q?\noptions:\n  - x\n  - y")
  assert.equal(textWithOptions.form, "invalid")
  const choiceOfOne = readQuestionFence("id: d\nkind: choice\nquestion: Q?\noptions:\n  - only")
  assert.equal(choiceOfOne.form, "invalid")
  assert.match(choiceOfOne.form === "invalid" ? choiceOfOne.faults.join("\n") : "", /two or more options/)
  const twoRecommended = readQuestionFence("id: e\nkind: choice\nquestion: Q?\noptions:\n  - label: x\n    recommended: true\n  - label: y\n    recommended: true")
  assert.match(twoRecommended.form === "invalid" ? twoRecommended.faults.join("\n") : "", /only ONE option/)
})

test("an id alone is a reference, and the id is read lowercased", () => {
  assert.deepEqual(readQuestionFence("id: Settings-Store"), { form: "ref", id: "settings-store" })
  assert.deepEqual(readQuestionFence("id: qst_ab12cd34ef56"), { form: "ref", id: "qst_ab12cd34ef56" })
})

test("every mistake is refused by name", () => {
  const faultsOf = (body: string) => {
    const r = readQuestionFence(body)
    assert.equal(r.form, "invalid", body)
    return r.form === "invalid" ? r.faults.join("\n") : ""
  }
  assert.match(faultsOf("kind: text\nquestion: Q?"), /no `id:`/)
  assert.match(faultsOf("id: Has Spaces\nkind: text\nquestion: Q?"), /an id is a slug/)
  assert.match(faultsOf("id: x\nquestion: Q?"), /no `kind:`/)
  assert.match(faultsOf("id: x\nkind: pick\nquestion: Q?"), /`kind: pick` — the kinds are/)
  assert.match(faultsOf("id: x\nkind: text"), /no `question:`/)
  assert.match(faultsOf("id: x\nkind: text\nquestion: Q?\nrecomended: true"), /unknown key `recomended:`/)
  assert.match(faultsOf("id: x\nkind: choice\nquestion: Q?\noptions:\n  - label: a\n    recomended: true\n  - b"), /option 1: unknown key `recomended:`/)
  assert.match(faultsOf("id: x\nkind: text\nquestion: Q?\nSome context without a delimiter"), /context for the human goes below a `---` line/)
  assert.match(faultsOf("id: qst_mine\nkind: text\nquestion: Q?"), /reserved/)
  assert.match(faultsOf("id: x\nkind: choice\nquestion: Q?\noptions:\n  - same\n  - Same"), /two options are labelled/)
  assert.match(faultsOf("id: x\nkind: secret\nquestion: Code?\nwhen: parent = Yes"), /cannot be a follow-up/)
  assert.match(faultsOf("id: x\nkind: text\nquestion: Q?\nwhen: parent"), /write the parent's id/)
  // A fault still names the id it could read, so a correction can point at the fence.
  const r = readQuestionFence("id: named\nkind: nope\nquestion: Q?")
  assert.equal(r.form === "invalid" && r.id, "named")
})

test("only an unquoted ```question opener is a fence — a sample wrapped in a longer fence is quoted, and a marker is legacy", () => {
  const quoted = "````md\n```question\nid: x\nkind: text\nquestion: Q?\n```\n````"
  assert.deepEqual(questionFenceBlocks(quoted), [])
  const marker = "```question qst_ab12cd34\n```"
  assert.deepEqual(questionFenceBlocks(marker), [])
  const unclosed = "```question\nid: x\nkind: text\nquestion: Q?"
  assert.deepEqual(questionFenceBlocks(unclosed), [])
  const two = `Intro.\n\n${fence("id: a\nkind: text\nquestion: A?")}\n\nBetween.\n\n${fence("id: b")}\n\nAfter.`
  const blocks = questionFenceBlocks(two)
  assert.deepEqual(blocks.map((b) => b.read.form), ["ask", "ref"])
  assert.equal(two.slice(blocks[0].start, blocks[0].end).trimEnd(), fence("id: a\nkind: text\nquestion: A?"))
  assert.equal(two.slice(blocks[1].end), "\nAfter.")
})

test("a follow-up attaches to its parent's option in the same message, and the whole tree registers as one root", () => {
  const text = [
    fence("id: settings-store\nkind: choice\nquestion: SQLite or JSON?\noptions:\n  - SQLite\n  - JSON file"),
    fence("id: sqlite-path\nkind: choice\nwhen: settings-store = sqlite\nquestion: Where should it live?\noptions:\n  - Beside the sessions database\n  - In the project's `.frizz/`"),
  ].join("\n\n")
  const out = questionFencesIn(text)
  assert.deepEqual(out.faults, [])
  assert.deepEqual(out.asks.map((a) => a.id), ["settings-store"])
  const root = out.asks[0].spec
  assert.equal(root.options?.[0].followUps?.[0].handle, "sqlite-path")
  assert.deepEqual(questionHandles(root), ["settings-store", "sqlite-path"])
})

test("a follow-up whose parent or option is missing is refused, and never takes its parent down with it", () => {
  const parent = fence("id: p\nkind: choice\nquestion: P?\noptions:\n  - Yes\n  - No")
  const orphan = questionFencesIn(fence("id: c\nkind: text\nwhen: elsewhere = Yes\nquestion: C?"))
  assert.deepEqual(orphan.asks, [])
  assert.match(orphan.faults[0].faults[0], /names no question in this message/)
  const wrongOption = questionFencesIn(`${parent}\n${fence("id: c\nkind: text\nwhen: p = Maybe\nquestion: C?")}`)
  assert.deepEqual(wrongOption.asks.map((a) => a.id), ["p"])
  assert.match(wrongOption.faults[0].faults[0], /only `Yes`, `No`/)
  const underMulti = questionFencesIn(`${fence("id: m\nkind: multi\nquestion: M?\noptions:\n  - a\n  - b")}\n${fence("id: c\nkind: text\nwhen: m = a\nquestion: C?")}`)
  assert.match(underMulti.faults[0].faults[0], /a multi's options cannot open follow-ups/)
})

test("the same fence twice in one message is one ask; two different fences on one id are a collision", () => {
  const a = fence("id: x\nkind: text\nquestion: Q?")
  assert.equal(questionFencesIn(`${a}\n${a}`).asks.length, 1)
  const out = questionFencesIn(`${a}\n${fence("id: x\nkind: text\nquestion: Different?")}`)
  assert.match(out.faults[0].faults[0], /two different questions in this message use `id: x`/)
})

test("a tree deeper than three levels is refused by the shared validator", () => {
  const out = assembleQuestionFences([
    { form: "ask", id: "a", spec: { handle: "a", question: "A?", kind: "question", options: [{ label: "go" }, { label: "no" }] } },
    { form: "ask", id: "b", spec: { handle: "b", question: "B?", kind: "question", options: [{ label: "go" }, { label: "no" }] }, when: { parent: "a", option: "go" } },
    { form: "ask", id: "c", spec: { handle: "c", question: "C?", kind: "question", options: [{ label: "go" }, { label: "no" }] }, when: { parent: "b", option: "go" } },
    { form: "ask", id: "d", spec: { handle: "d", question: "D?", kind: "question" }, when: { parent: "c", option: "go" } },
  ])
  assert.deepEqual(out.asks, [])
  assert.match(out.faults[0].faults.join("\n"), /4 levels deep; the limit is 3/)
})
