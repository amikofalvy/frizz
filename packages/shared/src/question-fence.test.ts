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

test("a follow-up whose option is missing is refused with its parent's real labels, and never takes its parent down with it", () => {
  const parent = fence("id: p\nkind: choice\nquestion: P?\noptions:\n  - Yes\n  - No")
  const wrongOption = questionFencesIn(`${parent}\n${fence("id: c\nkind: text\nwhen: p = Maybe\nquestion: C?")}`)
  assert.deepEqual(wrongOption.asks.map((a) => a.id), ["p"])
  // The labels are what lets the worker FIX the line rather than guess at it (the dead end found
  // 2026-10-13: `when: prefs-store = SQLite` against an option labelled `SQLite (better-sqlite3)`).
  assert.deepEqual(wrongOption.faults, [{ id: "c", faults: ["`when:` names the option `Maybe`, and `p` has only `Yes`, `No` — write the label exactly as the option has it"] }])
  const underMulti = questionFencesIn(`${fence("id: m\nkind: multi\nquestion: M?\noptions:\n  - a\n  - b")}\n${fence("id: c\nkind: text\nwhen: m = a\nquestion: C?")}`)
  assert.match(underMulti.faults[0].faults[0], /a multi's options cannot open follow-ups/)
  const underText = questionFencesIn(`${fence("id: t\nkind: text\nquestion: T?")}\n${fence("id: c\nkind: text\nwhen: t = anything\nquestion: C?")}`)
  assert.deepEqual(underText.asks.map((a) => a.id), ["t"])
  assert.match(underText.faults[0].faults[0], /`t` is a free-text question with no options to follow — ask this as its own question, without the `when:` line/)
})

test("a follow-up whose parent is not asked in its message is handed over unattached, for the server to place", () => {
  // Not a fault here: the parent may be a question the thread already has open, and only the server has
  // the rows. A follow-up of the follow-up, written beside it, rides inside it.
  const late = fence("id: c\nkind: choice\nwhen: elsewhere = Yes\nquestion: C?\noptions:\n  - One\n  - Two")
  const under = fence("id: d\nkind: text\nwhen: c = two\nquestion: D?")
  const out = questionFencesIn(`${fence("id: elsewhere")}\n${late}\n${under}`)
  assert.deepEqual(out.faults, [])
  assert.deepEqual(out.asks, [])
  assert.deepEqual(out.refs, ["elsewhere"])
  assert.deepEqual(out.followUps.map((f) => [f.id, f.parent, f.option]), [["c", "elsewhere", "Yes"]])
  assert.deepEqual(questionHandles(out.followUps[0].spec), ["c", "d"])
  assert.equal(out.followUps[0].spec.options?.[1].followUps?.[0].question, "D?")
})

test("a fence under a refused fence is named too, and a `when:` that circles back reaches nothing", () => {
  const parent = fence("id: p\nkind: choice\nquestion: P?\noptions:\n  - Yes\n  - No")
  const child = fence("id: c\nkind: choice\nwhen: p = Maybe\nquestion: C?\noptions:\n  - One\n  - Two")
  const grandchild = fence("id: g\nkind: text\nwhen: c = One\nquestion: G?")
  const out = questionFencesIn([parent, child, grandchild].join("\n\n"))
  assert.deepEqual(out.asks.map((a) => questionHandles(a.spec)), [["p"]])
  assert.deepEqual(out.faults.map((f) => f.id), ["c", "g"], "the grandchild is not simply missing from the correction")
  assert.match(out.faults[1].faults[0], /it follows `c`, which could not be asked/)
  const loop = questionFencesIn([
    fence("id: a\nkind: choice\nwhen: b = x\nquestion: A?\noptions:\n  - x\n  - y"),
    fence("id: b\nkind: choice\nwhen: a = x\nquestion: B?\noptions:\n  - x\n  - y"),
    fence("id: self\nkind: choice\nwhen: self = x\nquestion: S?\noptions:\n  - x\n  - y"),
  ].join("\n\n"))
  assert.deepEqual([loop.asks, loop.followUps], [[], []])
  assert.deepEqual(loop.faults.map((f) => f.id), ["a", "b", "self"])
  for (const f of loop.faults) assert.match(f.faults[0], /goes in a circle/)
})

test("the same fence twice in one message is one ask; two different fences on one id are a collision", () => {
  const a = fence("id: x\nkind: text\nquestion: Q?")
  assert.equal(questionFencesIn(`${a}\n${a}`).asks.length, 1)
  const out = questionFencesIn(`${a}\n${fence("id: x\nkind: text\nquestion: Different?")}`)
  assert.match(out.faults[0].faults[0], /two different questions in this message use `id: x`/)
})

test("a fourth level is refused on the fence that goes too deep — the three sound levels above it still register", () => {
  const out = assembleQuestionFences([
    { form: "ask", id: "a", spec: { handle: "a", question: "A?", kind: "question", options: [{ label: "go" }, { label: "no" }] } },
    { form: "ask", id: "b", spec: { handle: "b", question: "B?", kind: "question", options: [{ label: "go" }, { label: "no" }] }, when: { parent: "a", option: "go" } },
    { form: "ask", id: "c", spec: { handle: "c", question: "C?", kind: "question", options: [{ label: "go" }, { label: "no" }] }, when: { parent: "b", option: "go" } },
    { form: "ask", id: "d", spec: { handle: "d", question: "D?", kind: "question" }, when: { parent: "c", option: "go" } },
  ])
  // Refusing the whole tree here (as the shared validator would) took a sound question down with its
  // fourth level — and a follow-up never takes its parent down.
  assert.deepEqual(out.asks.map((a) => questionHandles(a.spec)), [["a", "b", "c"]])
  assert.deepEqual(out.faults.map((f) => f.id), ["d"])
  assert.match(out.faults[0].faults[0], /this would be level 4 under `a`, and follow-ups go 3 levels deep at most/)
})
