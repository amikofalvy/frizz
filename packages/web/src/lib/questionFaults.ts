// A REFUSED QUESTION FENCE IS THE CODE BLOCK IT IS — which message each refusal belongs to.
//
// The server registers a ```question fence as a row, or refuses it: its id is already spent on a different
// question, it follows a question the human has finished with, it is an `id:` reference to nothing. A
// refused fence has no row. So does a fence the registrar has not reached yet, which the transcript draws
// as the question it is about to become (a read-only card, for a second or two). Until 2026-10-13 the web
// could not tell the two apart, and it resolved a fence to a row by its id alone:
//
// - a refused fence with a NEW id sat on the page as a read-only card for good, looking askable;
// - a refused fence REUSING a spent id claimed that id's card: the old question's live card left the prose
//   it was asked in and drew under the new message, whose own question appeared nowhere.
//
// The board now carries what the thread's latest sync refused (ThreadView.questionFaults: the instant of
// the transcript record that held the fence, the fence's id, the server's reasons). This module turns that
// list into "these ids, in this message" and hangs it on the message, where every reader of a message's
// fences already looks: the splitter draws a refused fence as prose (lib/questionBlocks
// splitMessageQuestions — the same code block an unreadable fence gets), and the placement readers no
// longer count it as naming a question (questionFenceIdsIn), so it claims and moves nothing.
//
// MATCHED BY ID AND BY THE MESSAGE WHOSE TIME SPAN HOLDS THE FAULT'S INSTANT — never by comparing the
// instant with the bubble's own. A rendered message is one or more transcript records (Claude writes one
// record per content block and the projection merges them under the first record's instant), so a fence
// in a message's second text block is faulted at a LATER instant than the message's `at`. A message's
// span therefore runs from its own instant to the next message's, and the fault belongs to the last
// message stamped at or before it. Event lines and reasoning summaries do not start a span: "Agent rested"
// is stamped with the very record that ended the turn, which is often the record holding the fence.
//
// THE MESSAGE THAT REGISTERED A NAME IS NEVER FAULTED FOR IT. The server holds the same rule (its
// `registeredHere`), so a fault for an id whose row was asked inside this message's own span is not about
// this message's fence — it is about a later message this tab has not loaded yet. The board reaches the
// browser a frame or two ahead of the transcript (20-30ms measured), and in that beat the newest loaded
// message is the only one a fault's instant can land in. Without this the original question's fence
// turned into a code block for those frames and its card jumped out of the prose and back.
import type { AskedQuestion, QuestionFenceFaultView } from "@frizz/shared"
import { mayHoldQuestionFence, questionFenceBlocks } from "@frizz/shared"
import { resolveQuestionName } from "./questionShadow.ts"

export interface FaultMessage {
  role: string
  kind?: string
  at?: string
  text?: string
  /** The ids of this message's question fences the server refused, lowercased (withRefusedFences). */
  refusedFences?: ReadonlySet<string>
}

/** A row a fence's id can resolve to — open, answered, or closed without an answer (known by its one
 *  handle) — with the instant of the message that asked it. */
export interface FaultRow {
  id: string
  askedAt: string
  spec?: AskedQuestion
  handle?: string
}

/** The index of the message whose span holds `atMs`: the last message proper stamped at or before it, or
 *  -1 when the instant is older than everything loaded. */
export function messageIndexAt(messages: readonly FaultMessage[], atMs: number): number {
  let found = -1
  if (!Number.isFinite(atMs)) return found
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.kind === "event" || m.kind === "reasoning") continue
    const at = m.at ? Date.parse(m.at) : Number.NaN
    if (Number.isFinite(at) && at <= atMs) found = i
  }
  return found
}

/** The fence ids each message had REFUSED, keyed by message index, lowercased. A fault with no id (a fence
 *  too broken to have one) names nothing to match and is already a code block; a fault whose message is not
 *  loaded, or whose message carries no fence of that id, is left out. */
export function refusedFencesByMessage(
  messages: readonly FaultMessage[],
  faults: readonly QuestionFenceFaultView[] | undefined,
  rows: readonly FaultRow[] = [],
): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>()
  if (!faults?.length || messages.length === 0) return out
  const idsAt = new Map<number, Set<string>>()
  const fenceIdsOf = (i: number): Set<string> => {
    let ids = idsAt.get(i)
    if (!ids) {
      ids = new Set()
      const text = messages[i].text
      if (messages[i].role === "assistant" && text && mayHoldQuestionFence(text)) {
        for (const b of questionFenceBlocks(text)) if (b.read.form !== "invalid") ids.add(b.read.id.toLowerCase())
      }
      idsAt.set(i, ids)
    }
    return ids
  }
  for (const fault of faults) {
    if (!fault.id) continue
    const id = fault.id.toLowerCase()
    const at = messageIndexAt(messages, Date.parse(fault.at))
    if (at < 0 || !fenceIdsOf(at).has(id)) continue
    const row = resolveQuestionName(id, rows)
    if (row && messageIndexAt(messages, Date.parse(row.askedAt)) === at) continue
    const ids = out.get(at)
    if (ids) ids.add(id)
    else out.set(at, new Set([id]))
  }
  return out
}

// One annotated copy per (message, refused set), so a message's memo boundary moves only when what was
// refused IN IT changes — not on every board push that carries the same faults again.
const annotated = new WeakMap<object, { key: string; message: unknown }>()

/** The same messages, each one that had a fence refused carrying the refused ids as `refusedFences`. The
 *  input array itself comes back when nothing in it was refused, which is nearly always. */
export function withRefusedFences<M extends FaultMessage>(
  messages: readonly M[],
  faults: readonly QuestionFenceFaultView[] | undefined,
  rows: readonly FaultRow[] = [],
): readonly M[] {
  const refused = refusedFencesByMessage(messages, faults, rows)
  if (refused.size === 0) return messages
  return messages.map((m, i) => {
    const ids = refused.get(i)
    if (!ids) return m
    const key = [...ids].sort().join("\n")
    const known = annotated.get(m)
    if (known?.key === key) return known.message as M
    const message = { ...m, refusedFences: ids }
    annotated.set(m, { key, message })
    return message
  })
}

/** A stable key for a fault list, so a memo over it survives a board push that re-sends the same faults. */
export function questionFaultsKey(faults: readonly QuestionFenceFaultView[] | undefined): string {
  return faults?.length ? faults.map((f) => `${f.at}|${f.id ?? ""}`).join("\n") : ""
}
