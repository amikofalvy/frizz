import { useMemo } from "react"
import type { AwaitingHint, ThreadView } from "@frizz/shared"
import { awaitingSteps } from "@frizz/shared"
import { STEPS_DONE } from "./awaitingPresentation.ts"
import { draftKey, draftStore, useDraft, useProjectDir } from "./drafts.ts"

// THE STEPS CARD'S ANSWER (2026-10-12, maintainer: "The awaiting human block should switch over to be a
// big checkbox that says 'I have completed this.' Once you've checked it you should have the ability to
// submit it as an answer just as you can with any other question").
//
// So the card's checkbox STAGES an answer, exactly as picking a question's option does, and nothing
// leaves until the surface's one send (lib/sendScope) — the prompt box's Send, or Enter — carries it,
// together with whatever is typed in the box. Until then the card sent the word the moment Done was
// pressed, and a note had to follow as a second message.
//
// THE TICK LIVES IN THE DRAFT STORE, like a question's staged picks: the same card draws on the queue
// card, in the drawer and on /full, each beside its own prompt box, and a reader who ticks it in one
// must find it ticked in the others and after a reload. Keyed by the thread and the steps' own text, so a
// later fence handing over different steps starts unticked.

/** The slice of a thread these read — READONLY all the way down, because the prompt box hands in the
 *  board's frozen snapshot rather than a ThreadView. */
type StepsThread = {
  readonly id: string
  readonly runtime: ThreadView["runtime"]
  readonly lastFence?: { readonly kind: NonNullable<ThreadView["lastFence"]>["kind"]; readonly hints: readonly AwaitingHint[] }
}

/** Is the thread resting on EXACTLY these steps right now — the board's own last fence, at rest? Only
 *  then may anything answer them. A fence the transcript hands in is a rest the thread may already have
 *  left: the tailer clears `lastFence` on the human's very next message, so a steps card drawn after the
 *  reply is a record of what was asked, and a second answer would send twice. */
export function restingOnSteps(thread: Omit<StepsThread, "id"> | undefined, steps: readonly string[]): boolean {
  if (steps.length === 0 || thread?.runtime !== "turn-idle" || thread.lastFence?.kind !== "awaiting") return false
  const live = awaitingSteps(thread.lastFence.hints)
  return live.length === steps.length && live.every((step, i) => step === steps[i])
}

// FNV-1a, 32-bit: a short stable key for a list that can run to thousands of characters.
export function stepsHash(steps: readonly string[]): string {
  let h = 0x811c9dc5
  const text = steps.join("\u0000")
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${steps.length}.${(h >>> 0).toString(36)}`
}

const CHECKED = "1"

/** The card's checkbox: whether it is ticked, and the setter. */
export function useStepsChecked(slug: string, steps: readonly string[]): readonly [boolean, (checked: boolean) => void] {
  const projectDir = useProjectDir()
  const key = useMemo(() => draftKey.steps(projectDir, slug, stepsHash(steps)), [projectDir, slug, steps])
  const [value, set, clear] = useDraft(key)
  return [value === CHECKED, (checked: boolean) => (checked ? set(CHECKED) : clear())] as const
}

/** The reply a ticked card sends: the word, and the human's note under it when they typed one. */
export function withStepsDone(note: string): string {
  const trimmed = note.trim()
  return trimmed ? `${STEPS_DONE}\n\n${trimmed}` : STEPS_DONE
}

/** The staged answer as the prompt box's send needs it. */
export interface StepsTake {
  /** The send has committed locally: the box unticks, as a sent question's picks clear. */
  onOptimistic: () => void
  /** The send was refused: tick it again. */
  onRollback: () => void
}

/** For the PROMPT BOX: is the card's answer staged, and the hand-off of it to a send. Staged only while
 *  the thread rests on the very steps that were ticked — a tick left behind by a card the thread has
 *  moved past answers nothing. */
export function useStepsAnswer(thread: StepsThread | undefined): { staged: boolean; take: () => StepsTake | null } {
  const projectDir = useProjectDir()
  const fence = thread?.lastFence?.kind === "awaiting" ? thread.lastFence : undefined
  const steps = useMemo(() => (fence ? awaitingSteps(fence.hints) : []), [fence])
  const key = thread && steps.length > 0 ? draftKey.steps(projectDir, thread.id, stepsHash(steps)) : ""
  const [value] = useDraft(key)
  const staged = key !== "" && value === CHECKED && restingOnSteps(thread, steps)
  const take = (): StepsTake | null => (staged
    ? { onOptimistic: () => draftStore.clear(key), onRollback: () => draftStore.set(key, CHECKED) }
    : null)
  return { staged, take }
}
