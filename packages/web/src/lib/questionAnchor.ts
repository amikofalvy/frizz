// WHERE A REGISTERED QUESTION SITS IN THE TRANSCRIPT: at the newest rest that CLAIMS it — the rest it
// was asked at, or a later rest that names it: a ```question fence carrying its `id:` (2026-10-13), or an
// ```awaiting fence listing it under `questions:` (the older form, still read). Never at a rest that says
// nothing about it.
//
// A ```question fence needs none of this — it IS a message, so it renders where it was written. A
// REGISTERED question is a row in `thread_question` with no message to live in, so its position is a
// decision, and it has been the wrong one three times:
//
// - Until 2026-08-27 the card was pinned above the composer. The moment the human replied past it, it
//   sat UNDER their own newest message and under everything the worker had done since, claiming to be
//   the current ask (maintainer 2026-08-27: "The questions should show up in the chat wherever the
//   session came to rest").
// - 2026-08-27 froze it at the rest that asked it — and then a worker that rested AGAIN with the
//   question open left the newest rest reading as a bare stop (maintainer 2026-08-31: "Why was this able
//   to come to rest without a proper handoff?").
// - 2026-08-31 therefore pulled every open question to the CURRENT rest. That took each card out of the
//   prose it was placed in and stacked them all under whatever the worker said last — a CI wake, an
//   unrelated reply — where they superseded the worker's own sign-off (maintainer 2026-10-01: "the
//   questions are taken out of the place where they were sort of embedded in the transcript and all
//   just show up in a bunch at the bottom of the chat"; 2026-10-05: "the pending questions that may or
//   may not be relevant kind of supersede how the agent actually signed off"). Measured over the 867
//   questions asked here since 2026-09-11, 38% outlived a later rest, and 72% of those resumes were
//   wakes, not the human.
//
// The fix for the 2026-08-31 report now lives in the CONTRACT, not here: a question is a sign-off only at
// the rest that asked it, and at every later rest the worker names each one it still needs under
// `questions:` or withdraws it (server scheduler.evalSignoffNudges / evalParkIntegrity). So the newest
// rest never reads as a bare stop with an ask hidden above it, and this file only has to honour what the
// worker said: a card stays where it was asked until a later rest claims it, and a claim moves it to the
// end of that rest — under the fence that named it.

import { type AskedQuestion, awaitingQuestions, questionHandles } from "@frizz/shared"
import { splitFenceBlocks } from "./fenceBlocks.ts"
import { questionFenceIdsIn } from "./questionBlocks.ts"

export interface AnchorMessage {
  role: string
  kind?: string
  at?: string
  /** The message's markdown, read only for an ```awaiting fence's `questions:` claim. */
  text?: string
}

/** A real human turn — a typed reply or one of frizz's own deliveries, which land as user records and
 *  count deliberately (the thread moved on, whoever moved it). Punctuation with a nominal role (an event
 *  line, a reasoning summary) is not a turn. */
function isTurn(m: AnchorMessage): boolean {
  return m.role === "user" && m.kind !== "event" && m.kind !== "reasoning"
}

/** The last message of the rest message `i` belongs to: the one before the next human turn, or the tail
 *  when no turn follows. */
export function restEnd(messages: readonly AnchorMessage[], i: number): number {
  for (let j = i + 1; j < messages.length; j++) {
    if (isTurn(messages[j])) return j - 1
  }
  return messages.length - 1
}

/** The index of the message closing the rest this question was ASKED at — the card renders after it.
 *  `messages.length - 1` when nothing has happened since (the common case — the worker asked and rested,
 *  and the card is still the tail), and `-1` when the rest it belongs to is older than the loaded window,
 *  which puts it at the top of what is loaded rather than back at the bottom where it would lie about
 *  being current. */
export function questionAnchorIndex(messages: readonly AnchorMessage[], askedAt: string): number {
  const asked = Date.parse(askedAt)
  const tail = messages.length - 1
  if (!Number.isFinite(asked)) return tail
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!isTurn(m)) continue
    const at = m.at ? Date.parse(m.at) : Number.NaN
    if (!Number.isFinite(at) || at <= asked) continue
    return i - 1
  }
  return tail
}

/** The newest worker message that CLAIMS each question, keyed by the lowercased name it used: an
 *  ```awaiting fence naming it under `questions:` (a `qst_…` id — the key is still read for workers whose
 *  contract predates the question fence, though no longer taught), or a ```question fence carrying its
 *  `id:` — a reference, or the ask restated (2026-10-13: the `id:`-only fence replaced `questions:` as the
 *  way a worker says it still needs an answer at this rest). A name is a row id or a handle; questionsByAnchor
 *  matches both. A message with neither fence costs two substring tests. */
export function questionClaims(messages: readonly AnchorMessage[]): Map<string, number> {
  const claims = new Map<string, number>()
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || !m.text) return
    if (m.text.includes("```awaiting")) {
      for (const seg of splitFenceBlocks(m.text)) {
        if (seg.kind !== "fence" || seg.fenceKind !== "awaiting") continue
        for (const id of awaitingQuestions(seg.hints)) claims.set(id.toLowerCase(), i)
      }
    }
    for (const id of questionFenceIdsIn(m.text)) claims.set(id, i)
  })
  return claims
}

/** The newest claim on this question under any of its names — its row id or a handle in its tree. */
function claimOf(claims: ReadonlyMap<string, number>, q: { id?: string; spec?: AskedQuestion }): number | undefined {
  let newest: number | undefined
  const take = (name: string) => {
    const at = claims.get(name.toLowerCase())
    if (at !== undefined && (newest === undefined || at > newest)) newest = at
  }
  if (q.id) take(q.id)
  if (q.spec) for (const h of questionHandles(q.spec)) take(h)
  return newest
}

/** Every question grouped by the message index it renders after, so a call site walks the transcript once
 *  and drops each group in place. Questions asked in ONE `ask` call share an instant and therefore a
 *  group, which is what keeps a batch rendering as one stack — and a fence naming several questions
 *  gathers them into one group at its own rest the same way.
 *
 *  `claims: false` reads the ASKING rest alone, ignoring any later fence — the reading lib/questionShadow's
 *  fold needs, because a fence restating a question must fold from the rest that asked it onward. */
export function questionsByAnchor<Q extends { askedAt: string; id?: string; spec?: AskedQuestion }>(
  messages: readonly AnchorMessage[],
  questions: readonly Q[],
  opts: { claims?: boolean } = {},
): Map<number, Q[]> {
  const byAnchor = new Map<number, Q[]>()
  const claims = opts.claims === false || questions.length === 0 ? undefined : questionClaims(messages)
  for (const q of questions) {
    let anchor = questionAnchorIndex(messages, q.askedAt)
    const claimedAt = claims ? claimOf(claims, q) : undefined
    if (claimedAt !== undefined && claimedAt > anchor) anchor = restEnd(messages, claimedAt)
    const group = byAnchor.get(anchor)
    if (group) group.push(q)
    else byAnchor.set(anchor, [q])
  }
  return byAnchor
}
