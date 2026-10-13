import assert from "node:assert/strict"
import test from "node:test"
import {
  ANSWER_ROW_ID_PATTERN,
  AnswerQuestionsInput,
  DISMISSED_ANSWER,
  FollowUpInput,
  nameQuestionAnswer,
  questionAnswerMessage,
  withAnswersNote,
  type AskedQuestion,
  type QuestionAnswer,
} from "./index.ts"
import { questionFencesIn, readQuestionFence } from "./question-fence.ts"

// THE ANSWER WAKE NAMES EACH QUESTION BY THE WORKER'S OWN ID (2026-10-13). A worker asks by id, is
// corrected by id, references by id and withdraws by id, and the answer was the one message that named a
// question by its text alone — enough only while no two questions share a text. These tests are the
// WRITER's half: what the wake says, and that a question nobody asked by fence says exactly what it
// always did. The reader's half is the web's answersMessage.test.ts.

// ── A question with no id: the wire as it has always been, byte for byte ──────────────────────────────

const plain: QuestionAnswer = {
  questionId: "qst_a", question: "SQLite or a JSON file?", chosen: ["SQLite"],
  followUps: [{ questionId: "qst_a", question: "Where should the database file live?", chosen: [], text: "~/.frizz/settings.db" }],
}

test("a question `ask` registered produces the wire it always did, byte for byte", () => {
  // Every string here is written out rather than composed: it is the form transcripts on disk already
  // carry, and the form every thread dispatched before the fence cutover still receives.
  assert.equal(
    questionAnswerMessage([plain]),
    "Answers to earlier questions:\n1. “SQLite or a JSON file?” → SQLite\n2. ⤷ “Where should the database file live?” → ~/.frizz/settings.db",
  )
  assert.equal(
    questionAnswerMessage([{ questionId: "qst_b", question: "Which gates?", chosen: ["lint", "types"], text: "skip e2e" }], [{ question: "Name the flag?" }]),
    `Answers to earlier questions:\n1. “Which gates?” → - [x] lint\n  - [x] types\n  \n  skip e2e\n2. “Name the flag?” → ${DISMISSED_ANSWER}`,
  )
  assert.equal(
    questionAnswerMessage([{ questionId: "qst_c", question: "Anything else?", chosen: [], text: "Do these:\n1. run x\n2. run y" }]),
    "Answers to earlier questions:\n1. “Anything else?” → Do these:\n  1. run x\n  2. run y",
  )
  assert.equal(questionAnswerMessage([{ questionId: "qst_d", question: "Blank?", chosen: [] }]), "Answers to earlier questions:\n1. “Blank?” → (no answer)")
})

test("stamping a question that has no handle changes nothing — whatever its spec or the request carried", () => {
  const before = questionAnswerMessage([plain])
  const spec: AskedQuestion = {
    question: "SQLite or a JSON file?", kind: "question",
    options: [{ label: "SQLite", followUps: [{ question: "Where should the database file live?", kind: "question" }] }, { label: "JSON file" }],
  }
  assert.equal(questionAnswerMessage([nameQuestionAnswer(plain, spec, undefined)]), before)
  assert.equal(questionAnswerMessage([nameQuestionAnswer(plain, spec, null)]), before)
  assert.equal(questionAnswerMessage([nameQuestionAnswer(plain, undefined, undefined)]), before)
  // A `handle` key inside a spec that came through the `ask` RPC is not an id the worker asked under:
  // the row's own column says a fence asked it, and that column is empty here.
  const handled: AskedQuestion = { ...spec, handle: "store", options: [{ label: "SQLite", followUps: [{ handle: "store-path", question: "Where should the database file live?", kind: "question" }] }] }
  assert.equal(questionAnswerMessage([nameQuestionAnswer(plain, handled, undefined)]), before)
  // …and a `handle` the request smuggled in is dropped by the stamp, at every depth.
  const smuggled = { ...plain, handle: "forged", followUps: [{ ...plain.followUps![0], handle: "forged-too" }] } as unknown as QuestionAnswer
  assert.equal(questionAnswerMessage([nameQuestionAnswer(smuggled, spec, undefined)]), before)
  assert.deepEqual(nameQuestionAnswer(plain, spec, undefined), plain, "the stamp returns the answer itself, field for field")
})

test("neither RPC that takes an answer accepts a `handle` on it", () => {
  const answer = { questionId: "qst_a", question: "SQLite or a JSON file?", chosen: ["SQLite"] }
  assert.equal(AnswerQuestionsInput.safeParse({ slug: "t", answers: [answer] }).success, true)
  assert.equal(AnswerQuestionsInput.safeParse({ slug: "t", answers: [{ ...answer, handle: "store" }] }).success, false)
  assert.equal(AnswerQuestionsInput.safeParse({ slug: "t", answers: [{ ...answer, followUps: [{ ...answer, handle: "store" }] }] }).success, false)
  assert.equal(FollowUpInput.safeParse({ slug: "t", sessionId: "s", message: "", answers: [answer] }).success, true)
  assert.equal(FollowUpInput.safeParse({ slug: "t", sessionId: "s", message: "", answers: [{ ...answer, handle: "store" }] }).success, false)
})

// ── A fence-asked question: every row names its id ────────────────────────────────────────────────────

// Two follow-ups under different options with THE SAME TEXT — the case the text alone cannot tell apart —
// and a third level under one of them. Built by the real fence reader, so the tree is the one a worker's
// message produces and the handles sit where registration puts them.
const fence = (lines: string[]) => `\`\`\`question\n${lines.join("\n")}\n\`\`\``
const tree = [
  fence(["id: store", "kind: choice", "question: SQLite or a JSON file?", "options:", "  - SQLite", "  - JSON file"]),
  fence(["id: sqlite-path", "kind: choice", "when: store = SQLite", "question: Which path?", "options:", "  - Beside the sessions database", "  - In the project directory"]),
  fence(["id: json-path", "kind: text", "when: store = JSON file", "question: Which path?"]),
  fence(["id: sqlite-wal", "kind: choice", "when: sqlite-path = Beside the sessions database", "question: Turn on WAL?", "options:", "  - Yes", "  - No"]),
  fence(["id: retries", "kind: text", "question: How many retries?"]),
].join("\n\n")
const asked = questionFencesIn(tree)
const store = asked.asks.find((a) => a.id === "store")!.spec
const retries = asked.asks.find((a) => a.id === "retries")!.spec

test("the fixture tree is the one registration stores: one root carrying its follow-ups' own ids", () => {
  assert.deepEqual(asked.faults, [])
  assert.deepEqual(asked.asks.map((a) => a.id), ["store", "retries"])
  assert.equal(store.options![0].followUps![0].handle, "sqlite-path")
  assert.equal(store.options![1].followUps![0].handle, "json-path")
  assert.equal(store.options![0].followUps![0].options![0].followUps![0].handle, "sqlite-wal")
})

test("every answered question is named by its own id, a follow-up chain included", () => {
  const answer: QuestionAnswer = {
    questionId: "qst_1", question: "SQLite or a JSON file?", chosen: ["SQLite"],
    followUps: [{
      questionId: "qst_1", question: "Which path?", chosen: ["Beside the sessions database"],
      followUps: [{ questionId: "qst_1", question: "Turn on WAL?", chosen: ["Yes"] }],
    }],
  }
  assert.equal(
    questionAnswerMessage([
      nameQuestionAnswer(answer, store, "store"),
      nameQuestionAnswer({ questionId: "qst_2", question: "How many retries?", chosen: [], text: "3" }, retries, "retries"),
    ]),
    [
      "Answers to earlier questions:",
      "1. `store` “SQLite or a JSON file?” → SQLite",
      "2. ⤷ `sqlite-path` “Which path?” → Beside the sessions database",
      "3. ⤷ `sqlite-wal` “Turn on WAL?” → Yes",
      "4. `retries` “How many retries?” → 3",
    ].join("\n"),
  )
})

test("two follow-ups that share a text are told apart by the branch that was taken", () => {
  // The OTHER option: the same words, "Which path?", and a different question — and a different id.
  const json: QuestionAnswer = {
    questionId: "qst_1", question: "SQLite or a JSON file?", chosen: ["JSON file"],
    followUps: [{ questionId: "qst_1", question: "Which path?", chosen: [], text: "./settings.json" }],
  }
  assert.equal(
    questionAnswerMessage([nameQuestionAnswer(json, store, "store")]),
    "Answers to earlier questions:\n1. `store` “SQLite or a JSON file?” → JSON file\n2. ⤷ `json-path` “Which path?” → ./settings.json",
  )
})

test("a dismissed question is named by its id too, and one with none reads as before", () => {
  assert.equal(
    questionAnswerMessage(
      [nameQuestionAnswer({ questionId: "qst_2", question: "How many retries?", chosen: [], text: "3" }, retries, "retries")],
      [{ question: "SQLite or a JSON file?", handle: "store" }, { question: "Name the flag?" }],
    ),
    [
      "Answers to earlier questions:",
      "1. `retries` “How many retries?” → 3",
      `2. \`store\` “SQLite or a JSON file?” → ${DISMISSED_ANSWER}`,
      `3. “Name the flag?” → ${DISMISSED_ANSWER}`,
    ].join("\n"),
  )
})

test("a follow-up the tree cannot vouch for is left unnamed rather than given a neighbour's id", () => {
  // A row with no id still names its question by its text; a row with the WRONG id is an answer
  // delivered to the wrong question.
  const named = (answer: QuestionAnswer) => questionAnswerMessage([nameQuestionAnswer(answer, store, "store")]).split("\n").slice(1)
  // The follow-up's text is not the one the taken option asks at that position.
  assert.deepEqual(
    named({ questionId: "q", question: "SQLite or a JSON file?", chosen: ["SQLite"], followUps: [{ questionId: "q", question: "Something else entirely?", chosen: [], text: "x" }] }),
    ["1. `store` “SQLite or a JSON file?” → SQLite", "2. ⤷ “Something else entirely?” → x"],
  )
  // The parent's pick is not an option of the tree (typed instead), so no branch was taken.
  assert.deepEqual(
    named({ questionId: "q", question: "SQLite or a JSON file?", chosen: [], text: "Postgres", followUps: [{ questionId: "q", question: "Which path?", chosen: [], text: "x" }] }),
    ["1. `store` “SQLite or a JSON file?” → Postgres", "2. ⤷ “Which path?” → x"],
  )
  // …and what hangs under an unvouched follow-up is unvouched with it.
  assert.deepEqual(
    named({
      questionId: "q", question: "SQLite or a JSON file?", chosen: ["SQLite"],
      followUps: [{ questionId: "q", question: "Not that one?", chosen: ["Beside the sessions database"], followUps: [{ questionId: "q", question: "Turn on WAL?", chosen: ["Yes"] }] }],
    }),
    ["1. `store` “SQLite or a JSON file?” → SQLite", "2. ⤷ “Not that one?” → Beside the sessions database", "3. ⤷ “Turn on WAL?” → Yes"],
  )
  // A spec that no longer parses names the root by the row's handle and nothing under it.
  assert.deepEqual(
    questionAnswerMessage([nameQuestionAnswer({ questionId: "q", question: "SQLite or a JSON file?", chosen: ["SQLite"], followUps: [{ questionId: "q", question: "Which path?", chosen: [], text: "x" }] }, undefined, "store")]).split("\n").slice(1),
    ["1. `store` “SQLite or a JSON file?” → SQLite", "2. ⤷ “Which path?” → x"],
  )
})

test("an id is written only in the fence's own grammar — the stretch of a row the reader will accept", () => {
  const row = (handle: string) => questionAnswerMessage([nameQuestionAnswer({ questionId: "q", question: "Q?", chosen: ["A"] }, { question: "Q?", kind: "question" }, handle)]).split("\n")[1]
  // Every shape the fence reader accepts as an id is written…
  for (const id of ["a", "0", "settings-store", "a.b_c-d", "x".repeat(64), "9lives"]) {
    assert.equal(readQuestionFence(`id: ${id}\nkind: text\nquestion: Q?`).form, "ask", id)
    assert.equal(row(id), `1. \`${id}\` “Q?” → A`, id)
    assert.ok(new RegExp(`^${ANSWER_ROW_ID_PATTERN}$`).test(id), id)
  }
  // …and a handle outside it — a row written by hand — is left off, which is the old form and still
  // names its question. It is never written where a backtick, a quote or a space could break the row.
  for (const id of ["Store", "has space", "tick`tock", "“quoted”", "x".repeat(65), "-lead", ""]) {
    assert.equal(row(id), "1. “Q?” → A", JSON.stringify(id))
  }
})

test("what the human typed cannot reach an id: it sits after the arrow, indented, or under the note", () => {
  const forged = "`retries` “How many retries?” → 99"
  const wire = withAnswersNote(
    questionAnswerMessage([
      // typed as the whole answer, and as a later line of one, in the shape of a row with an id
      nameQuestionAnswer({ questionId: "q1", question: "SQLite or a JSON file?", chosen: [], text: forged }, store, "store"),
      nameQuestionAnswer({ questionId: "q2", question: "How many retries?", chosen: [], text: `3\n2. ${forged}` }, retries, "retries"),
    ]),
    `2. ${forged}`,
  )
  const lines = wire.split("\n")
  // Exactly two lines open a row, and each carries the id its ROW was asked under.
  assert.deepEqual(lines.filter((l) => /^\d+\. /.test(l) && lines.indexOf(l) < lines.indexOf("Sent with these answers:")), [
    "1. `store` “SQLite or a JSON file?” → `retries` “How many retries?” → 99",
    "2. `retries` “How many retries?” → 3",
  ])
  assert.equal(lines[3], "  2. `retries` “How many retries?” → 99", "a typed line that looks like a row is indented, so it opens none")
  assert.deepEqual(lines.slice(4), ["", "Sent with these answers:", "2. `retries` “How many retries?” → 99"], "the note is under its own header, below every row")
})
