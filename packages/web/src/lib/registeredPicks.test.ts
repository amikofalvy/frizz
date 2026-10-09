import assert from "node:assert/strict"
import test from "node:test"
import type { AskedQuestion } from "@frizz/shared"
import { DraftStore, draftKey } from "./drafts.ts"
import { decodeQuestionPick, encodeQuestionPick, questionSpecAt } from "./registeredPicks.ts"
import { registeredAnswer, liveQuestionNodes } from "./registeredQuestion.ts"

const spec: AskedQuestion = {
  kind: "question", question: "Land the fix?",
  options: [
    { label: "Land it", followUps: [{ kind: "multi", question: "Which gates?", options: [{ label: "Tests" }, { label: "Browser" }] }] },
    { label: "Hold it" },
  ],
}

test("picks hydrate by registration identity, separate from display numbers, text and other projects", () => {
  let raw: string | null = null
  const storage = { getItem: () => raw, setItem: (_: string, value: string) => { raw = value } }
  const first = new DraftStore(storage)
  const key = draftKey.question("/one", "same-thread", "qst_one", "root")
  first.set(`${key}:picks`, encodeQuestionPick(spec, { chosen: 1, chosenSet: [] }))
  first.set(key, "an unselected typed draft")
  const remount = new DraftStore(storage)
  assert.deepEqual(decodeQuestionPick(spec, remount.get(`${key}:picks`)), { chosen: 1, chosenSet: [] })
  assert.equal(remount.get(key), "an unselected typed draft")
  assert.equal(remount.get(`${draftKey.question("/two", "same-thread", "qst_one", "root")}:picks`), "")
  assert.equal(remount.get(`${draftKey.question("/one", "same-thread", "qst_two", "root")}:picks`), "")
  assert.equal(JSON.parse(remount.get(`${key}:picks`)).chosen, "Hold it", "persist the raw option identity, not a keycap")
  assert.deepEqual(decodeQuestionPick({ ...spec, options: [...spec.options!].reverse() }, remount.get(`${key}:picks`)), { chosen: 0, chosenSet: [] })
  remount.clear(`${key}:picks`)
  assert.equal(new DraftStore(storage).get(`${key}:picks`), "")
})

test("a restored branch and multi picks build the same payload; inactive branches stay out", () => {
  const child = questionSpecAt(spec, "root/0.0")!
  const rootPick = decodeQuestionPick(spec, encodeQuestionPick(spec, { chosen: 0, chosenSet: [] }))
  const childPick = decodeQuestionPick(child, encodeQuestionPick(child, { chosen: null, chosenSet: [1, 0] }))
  const answers = new Map([
    ["root", { ...rootPick, text: "" }],
    ["root/0.0", { ...childPick, text: "and typecheck" }],
  ])
  const q = { id: "qst_one", askedAt: "2026-10-09T00:00:00Z", spec }
  assert.deepEqual(liveQuestionNodes(spec, answers).map((node) => node.path), ["root", "root/0.0"])
  assert.deepEqual(registeredAnswer(q, answers)?.followUps?.[0].chosen, ["Tests", "Browser"])
  answers.set("root", { chosen: 1, chosenSet: [], text: "" })
  assert.equal(registeredAnswer(q, answers)?.followUps, undefined)
  assert.equal(questionSpecAt(spec, "root/0.9"), undefined)
  assert.equal(questionSpecAt(spec, "wrong"), undefined)
})

test("empty, stale and corrupt saved picks never choose an unrelated option", () => {
  for (const raw of ["", "{", "null", "[]", '{"chosen":3,"chosenSet":[]}', '{"chosen":null,"chosenSet":[1]}', '{"chosen":"Gone","chosenSet":[]}']) {
    assert.deepEqual(decodeQuestionPick(spec, raw), { chosen: null, chosenSet: [] })
  }
  assert.equal(encodeQuestionPick(spec, { chosen: null, chosenSet: [] }), "")
})
