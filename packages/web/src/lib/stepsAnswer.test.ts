import { test } from "node:test"
import assert from "node:assert/strict"
import { BURIED_ANSWERS_HEADER, questionAnswerMessage, withAnswersNote } from "@frizz/shared"
import { repliesStepsDone, stepsDoneReplies, withStepsDone } from "./stepsAnswer.ts"

// Every shape the prompt box's one send gives a ticked box (ThreadComposerBox `send`): the word alone, the
// word over a typed note, under the fenced answers' wire, and under the server's registered answers too.
const FENCED = `${BURIED_ANSWERS_HEADER}\n1. “Which ORM should the docs examples use?” → A. Drizzle`
const REGISTERED = questionAnswerMessage([{ handle: "changelog", question: "What should the changelog entry say?", chosen: [], text: "Redesigned docs" }])

test("a reply is the box's when the word opens the human's own words, under any answers that rode with it", () => {
  for (const reply of [
    withStepsDone(""),
    withStepsDone("Approved it from the owner account."),
    withAnswersNote(FENCED, withStepsDone("")),
    withAnswersNote(REGISTERED, withStepsDone("Approved.")),
    withAnswersNote(REGISTERED, withAnswersNote(FENCED, withStepsDone("Approved."))),
  ]) assert.equal(repliesStepsDone(reply), true, reply)
})

test("a reply that only mentions done, or answers without the word, is not the box's", () => {
  for (const reply of [
    "Done with the copy edits, now which account?",
    "Not done yet",
    "done",
    FENCED,
    withAnswersNote(REGISTERED, "Which account should approve it?"),
    withAnswersNote(REGISTERED, FENCED),
  ]) assert.equal(repliesStepsDone(reply), false, reply)
})

const say = (text: string) => ({ role: "assistant", text })
const human = (text: string) => ({ role: "user", text })
const STEPS = "```awaiting\nsteps:\n  - Approve the DNS record.\n```"

test("the rest a reply answers is the agent message before it, up to the worker's next word", () => {
  const messages = [
    human("Ship it."),
    say(`Built.\n\n${STEPS}`), // 1 — answered with the box
    human("Done"),
    say(`Published. One more:\n\n${STEPS}`), // 3 — answered in words
    human("Which account?"),
    { role: "assistant", kind: "event", text: "A sub-agent finished." },
    say(`The owner account.\n\n${STEPS}`), // 6 — the box, with a note, under answers
    human(withAnswersNote(FENCED, withStepsDone("Approved."))),
    say("Thanks."), // 8 — no fence, so no reply can make it one
    human("Done"),
  ].map((m) => ({ kind: undefined, ...m })) as Parameters<typeof stepsDoneReplies>[0]
  assert.deepEqual([...stepsDoneReplies(messages)], [1, 6])
})

test("a reply after the worker spoke again answers that later rest, never the earlier one", () => {
  const messages = [
    say(`Built.\n\n${STEPS}`),
    human("A timer fired."),
    say("Still waiting on the DNS record."),
    human("Done"),
  ].map((m) => ({ kind: undefined, ...m })) as Parameters<typeof stepsDoneReplies>[0]
  assert.deepEqual([...stepsDoneReplies(messages)], [])
})
