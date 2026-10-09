import type { AskedQuestion } from "@frizz/shared"
import type { BlockAnswer } from "./questionBlocks.ts"

export type QuestionPick = Required<Pick<BlockAnswer, "chosen" | "chosenSet">>

// The server stores a registration's spec verbatim for its durable qst_ id. Persist RAW labels,
// the same identities answerQuestions consumes, never the numbered/lettered display strings.
export function encodeQuestionPick(spec: AskedQuestion, pick: QuestionPick): string {
  const options = spec.options ?? []
  if (pick.chosen === null && pick.chosenSet.length === 0) return ""
  return JSON.stringify({
    chosen: pick.chosen === null ? null : options[pick.chosen]?.label ?? null,
    chosenSet: pick.chosenSet.flatMap((i) => options[i] ? [options[i].label] : []),
  })
}

export function decodeQuestionPick(spec: AskedQuestion, raw: string): QuestionPick {
  const empty: QuestionPick = { chosen: null, chosenSet: [] }
  if (!raw) return empty
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object") return empty
    const { chosen, chosenSet } = value as { chosen?: unknown; chosenSet?: unknown }
    if ((chosen !== null && typeof chosen !== "string") || !Array.isArray(chosenSet)
      || !chosenSet.every((label) => typeof label === "string")) return empty
    const options = spec.options ?? []
    const index = options.findIndex((o) => o.label === chosen)
    return spec.kind === "multi"
      ? { chosen: null, chosenSet: options.flatMap((o, i) => chosenSet.includes(o.label) ? [i] : []) }
      : { chosen: index < 0 ? null : index, chosenSet: [] }
  } catch {
    return empty
  }
}

/** Paths address the immutable registered tree, not a card's position on any surface. */
export function questionSpecAt(spec: AskedQuestion, path: string): AskedQuestion | undefined {
  const [root, ...steps] = path.split("/")
  if (root !== "root") return undefined
  let node: AskedQuestion | undefined = spec
  for (const step of steps) {
    if (!/^\d+\.\d+$/.test(step)) return undefined
    const [option, followUp] = step.split(".").map(Number)
    node = node?.options?.[option]?.followUps?.[followUp]
  }
  return node
}
