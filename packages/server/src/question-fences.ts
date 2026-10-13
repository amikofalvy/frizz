// THE QUESTION REGISTRAR — turns the ```question fences a worker writes into `thread_question` rows.
//
// The grammar and its reasons live with the parser (packages/shared/src/question-fence.ts). This is the
// half that touches storage: the tailer notes every assistant message carrying a fence
// (FoldState.questionSightings), and the scheduler hands those sightings here on every tick — mid-turn
// included, because asking does not end the turn. A router call that must see the worker's newest fence
// (`done`, `unask`) catches the tailer up and calls here first.
//
// ONE ROW PER ID, FOR THE LIFE OF THE THREAD. A new id registers; the same fence seen again (a refold
// after a restart, a worker restating its question) finds its row and is a no-op; a DIFFERENT question on
// a spent id, or the same one asked again after it settled, is refused. So replaying any amount of
// transcript can never mint a second row, and a worker can never silently re-open a question the human
// already answered. The check is a lookup rather than a constraint: Node is single-threaded and the
// storage calls are synchronous, so nothing can interleave between the lookup and the insert.
//
// NOTHING IS INFERRED FROM PROSE. The id is explicit, the row is the lifecycle, and the row outlives the
// message — which is the line between this and the two designs declined before it (plans/
// rest-by-registration.md: PR #33 guessed at settlement; the 2026-08-28 gate dropped a live question
// whenever a reference was forgotten).

import { randomUUID } from "node:crypto"
import {
  assembleQuestionFences,
  awaitingQuestions,
  questionFenceBlocks,
  questionFencesLive,
  questionHandles,
  QUESTION_FENCE_CORRECTION_LEAD,
  type AskedQuestion,
} from "@frizz/shared"
import type { QuestionSighting } from "./backend/types.ts"
import type { FenceView } from "./tailer.ts"
import type { Storage, ThreadQuestionRow } from "./storage.ts"

/** No fence written before this instant registers or is corrected. Before it a ```question fence with a
 *  body was prose on every thread dispatched after QUESTION_FENCE_RETIRED_AT, so a refold of an old
 *  transcript must not turn one into a question, or bump a worker that has been idle for a week. */
export const QUESTION_FENCES_REGISTER_FROM = "2026-10-13T20:00:00Z"
const REGISTER_FROM_MS = Date.parse(QUESTION_FENCES_REGISTER_FROM)

/** A fence that could not register, with the instant of the message that carried it. */
export interface QuestionFenceFault {
  at: string
  id?: string
  faults: string[]
}

export interface QuestionFenceSync {
  registered: ThreadQuestionRow[]
  faults: QuestionFenceFault[]
  /** Questions a message named at an instant — a reference fence, or a fence restating its own ask. */
  refs: { at: string; rowId: string }[]
}

/** Every handle a thread has spent, each pointing at the ROOT row that spent it, plus every row by its
 *  minted id so a `qst_…` reference resolves too. */
function handleIndex(rows: readonly ThreadQuestionRow[]): Map<string, ThreadQuestionRow> {
  const index = new Map<string, ThreadQuestionRow>()
  for (const row of rows) {
    index.set(row.id.toLowerCase(), row)
    if (row.handle) index.set(row.handle.toLowerCase(), row)
    const spec = parseSpec(row.spec)
    for (const h of spec ? questionHandles(spec) : []) index.set(h.toLowerCase(), row)
  }
  return index
}

function parseSpec(spec: string): AskedQuestion | undefined {
  try {
    return JSON.parse(spec) as AskedQuestion
  } catch {
    return undefined
  }
}

/** Is a fence the SAME question its row registered? Compared without follow-ups: a worker restating its
 *  question in a later message writes the parent fence and rarely its branches again, and the branches
 *  were fixed when the tree registered — a restatement can place the card, never change what it asks. */
function sameQuestion(rowSpec: string, spec: AskedQuestion): boolean {
  const stored = parseSpec(rowSpec)
  if (!stored) return false
  const root = (q: AskedQuestion) => JSON.stringify({ ...q, options: q.options?.map(({ followUps: _followUps, ...o }) => o) })
  return root(stored) === root(spec)
}

const SETTLED_WORD: Record<ThreadQuestionRow["state"], string> = {
  open: "open",
  answered: "answered",
  withdrawn: "withdrawn",
  dismissed: "dismissed by the human",
}

/**
 * Register every new question the sightings carry and report what could not register. Pure apart from
 * the inserts: a thread on the legacy contract, an archived thread and a sighting older than
 * QUESTION_FENCES_REGISTER_FROM are skipped before anything is read.
 */
export function syncQuestionFences(
  storage: Pick<Storage, "listThreadQuestions" | "askThreadQuestion" | "clearThreadDone" | "resetParkBumps">,
  input: {
    slug: string
    spawnedAt: string | number | null | undefined
    sightings: readonly QuestionSighting[] | undefined
    /** The thread's armed Goal, when it runs autonomously — a question there is refused (secrets aside). */
    autonomousGoal?: string
  },
): QuestionFenceSync {
  const out: QuestionFenceSync = { registered: [], faults: [], refs: [] }
  if (!input.sightings?.length || questionFencesLive(input.spawnedAt)) return out
  const rows = storage.listThreadQuestions(input.slug)
  const index = handleIndex(rows)
  for (const sighting of input.sightings) {
    const atMs = Date.parse(sighting.at)
    if (!Number.isFinite(atMs) || atMs < REGISTER_FROM_MS) continue
    const assembled = assembleQuestionFences(questionFenceBlocks(sighting.text).map((b) => b.read))
    for (const f of assembled.faults) out.faults.push({ at: sighting.at, ...f })
    for (const id of assembled.refs) {
      const row = index.get(id)
      if (!row) {
        out.faults.push({ at: sighting.at, id, faults: [`\`id: ${id}\` alone references a question, and no question of yours uses that id — to ask a new one, give the fence a \`kind:\` and a \`question:\``] })
      } else if (row.state !== "open" && (row.settled_at ?? 0) < atMs) {
        out.faults.push({ at: sighting.at, id, faults: [`\`${id}\` was already ${SETTLED_WORD[row.state]}, so there is nothing left to reference`] })
      } else out.refs.push({ at: sighting.at, rowId: row.id })
    }
    for (const ask of assembled.asks) {
      const spent = questionHandles(ask.spec).map((h) => [h, index.get(h.toLowerCase())] as const).find(([, row]) => row)
      if (spent) {
        const [handle, row] = spent as readonly [string, ThreadQuestionRow]
        const same = row.handle === ask.id && sameQuestion(row.spec, ask.spec)
        // THE SAME FENCE AGAIN: the message that asked it, replayed by a refold, or the worker restating
        // its own open question — which places the card again, exactly as a reference does.
        if (same && (row.state === "open" || atMs <= row.asked_at)) out.refs.push({ at: sighting.at, rowId: row.id })
        else if (same) {
          out.faults.push({ at: sighting.at, id: ask.id, faults: [`\`${ask.id}\` was already asked and ${SETTLED_WORD[row.state]} — an id is never reused; ask again under a new id if you still need an answer`] })
        } else {
          out.faults.push({ at: sighting.at, id: ask.id, faults: [`\`id: ${handle}\` is already used by a different question on this thread — choose a new id (an id is never reused, even once its question is settled)`] })
        }
        continue
      }
      // AUTONOMOUS MODE DECLINES THE ASK — the rule `ask` enforced at the moment of temptation, kept for
      // the fence: the thread was told to decide for itself. A secret is exempt, as it was there: a
      // credential is a value only the human holds, not a call the worker can make.
      if (input.autonomousGoal && !ask.spec.secret) {
        out.faults.push({
          at: sighting.at,
          id: ask.id,
          faults: [
            "this thread is running autonomously, so the question was not asked — decide it yourself and proceed, and say which way you went in your write-up. " +
            `Its standing instruction is: ${input.autonomousGoal.replace(/\s+/g, " ").slice(0, 400)}`,
          ],
        })
        continue
      }
      const row = storage.askThreadQuestion({
        id: `qst_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        slug: input.slug,
        spec: JSON.stringify(ask.spec),
        // The MESSAGE's instant, not the registrar's: it is what places the card at the rest that asked it.
        askedAtMs: atMs,
        handle: ask.id,
      })
      // A question trumps a done (router `ask`, setOwnThreadTimer) — and a fence that worked gives the
      // correction allowance back, the way an honoured park does.
      storage.clearThreadDone(input.slug)
      storage.resetParkBumps(input.slug)
      for (const h of questionHandles(ask.spec)) index.set(h.toLowerCase(), row)
      index.set(row.id.toLowerCase(), row)
      out.registered.push(row)
    }
  }
  return out
}

/**
 * The open questions that STAND at the thread's current rest — the ones that queue it and sign the rest
 * off. A question stands at the rest that asked it, and at any later rest that references it: an
 * `id:` fence, the worker restating its fence, or (for a worker whose contract predates the fence) an
 * ```awaiting fence naming it under `questions:`. An older question nobody references stays open and
 * answerable where it was asked, and says nothing about this rest (maintainer 2026-10-13: questions "may
 * get registered and never answered, and then they just sort of fade away. I think it's probably fine").
 *
 * The rest starts at the newest human turn (`lastUserAt`) — the same boundary every other rest rule here
 * reads.
 */
export function standingQuestions(
  rows: readonly ThreadQuestionRow[],
  tele: { lastUserAt?: string; questionSightings?: readonly QuestionSighting[]; lastFence?: FenceView } | undefined,
): ThreadQuestionRow[] {
  const open = rows.filter((q) => q.state === "open")
  if (open.length === 0) return []
  const restFrom = tele?.lastUserAt ? Date.parse(tele.lastUserAt) : Number.NEGATIVE_INFINITY
  const named = new Set<string>()
  const index = handleIndex(rows)
  for (const sighting of tele?.questionSightings ?? []) {
    if (!(Date.parse(sighting.at) > restFrom)) continue
    for (const b of questionFenceBlocks(sighting.text)) {
      if (b.read.form === "invalid") continue
      const row = index.get(b.read.id)
      if (row) named.add(row.id)
    }
  }
  if (tele?.lastFence?.kind === "awaiting") {
    for (const id of awaitingQuestions(tele.lastFence.hints)) {
      const row = index.get(id)
      if (row) named.add(row.id)
    }
  }
  return open.filter((q) => q.asked_at > restFrom || named.has(q.id))
}

/** The correction a worker gets when a fence of its current rest could not register. Its lead folds it out
 *  of the chat like every other fence correction (isParkCorrection). */
export function questionFenceCorrection(faults: readonly QuestionFenceFault[]): string {
  const asks = faults.some((f) => f.faults.some((x) => !/alone references|nothing left to reference/.test(x)))
  const lines = [
    `${QUESTION_FENCE_CORRECTION_LEAD}could not register, so ${asks ? "the human has NOT been asked" : "it placed nothing"}:`,
    "",
    ...faults.flatMap((f) => f.faults.map((x) => `- ${f.id ? `\`${f.id}\` — ` : ""}${x}`)),
    "",
    "Fix the fence and write it again in your next message; a fence that registers needs nothing else.",
    "The shape: `id:` (a slug of your own), `kind:` (`choice`, `multi`, `text` or `secret`), a one-line",
    "`question:`, and for `choice`/`multi` two or more `options:` — each `- label: …`, with optional",
    "`description:`, `recommended: true` and an indented `detail: |` block. Anything else the human needs",
    "goes below a `---` line as markdown. A fence with `id:` alone references a question you already asked.",
  ]
  return lines.join("\n")
}

/** The thread's armed Goal when it runs autonomously — the same reading the router's `ask` refused on. */
export function autonomousGoalOf(row: { recurring_on_rest?: number | null; recurring_prompt?: string | null }): string | undefined {
  if (row.recurring_on_rest !== 1) return undefined
  const prompt = row.recurring_prompt?.trim()
  return prompt ? prompt : undefined
}

/**
 * Registration on the TAILER's clock rather than the scheduler's. The scheduler ticks every 10s; the
 * tailer polls about once a second and calls `onChange` when anything it folded moved, and the board
 * rebuilds right after. Sweeping here, before that rebuild, is what lets a question the worker just wrote
 * reach the board as an answerable card on the same refresh that draws the message carrying it.
 *
 * Only a thread whose sightings CHANGED is read — the signature is the ring's length and its newest entry
 * — so a quiet board costs one map lookup per thread with a fenced message on record. Returns whether
 * anything registered, though the caller refreshes the board either way.
 */
export function createQuestionRegistrar(deps: {
  storage: Pick<Storage, "allSessions" | "listThreadQuestions" | "askThreadQuestion" | "clearThreadDone" | "resetParkBumps">
  tailer: { get(slug: string): { questionSightings?: QuestionSighting[] } | undefined }
  log?: (message: string) => void
}): { sweep(): boolean } {
  const seen = new Map<string, string>()
  return {
    sweep() {
      let registered = false
      for (const row of deps.storage.allSessions()) {
        if (row.state === "archived" || row.archived === 1) continue
        const sightings = deps.tailer.get(row.slug)?.questionSightings
        if (!sightings?.length) continue
        const newest = sightings[sightings.length - 1]
        const signature = `${row.session_id}|${sightings.length}|${newest.at}|${newest.text.length}`
        if (seen.get(row.slug) === signature) continue
        seen.set(row.slug, signature)
        const sync = syncQuestionFences(deps.storage, {
          slug: row.slug,
          spawnedAt: row.spawned_at,
          sightings,
          autonomousGoal: autonomousGoalOf(row),
        })
        if (sync.registered.length > 0) {
          registered = true
          deps.log?.(`questions: ${row.slug} registered ${sync.registered.map((q) => q.handle).join(", ")}`)
        }
      }
      return registered
    },
  }
}
