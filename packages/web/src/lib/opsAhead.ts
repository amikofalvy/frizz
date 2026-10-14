import { useEffect, useRef, useState } from "react"
import type { SubAgentView, ThreadView, TranscriptMessage } from "@frizz/shared"
import { REST_CATCH_UP_MS } from "./steering.ts"

// A SUB-AGENT THE BOARD REPORTS BEFORE THE TRANSCRIPT DOES — the same two-channel race lib/steering.ts
// reconciles for a turn's edges, on the op counts over the prompt box.
//
// A sub-agent is in two places on a thread's surface: its Agent row in the transcript, and its count in
// the line over the prompt box (QueueOpsSummary), which reads the BOARD's `subAgents`. The board delta
// and the transcript push report the same launch, and the same finish, about 20ms apart, board first
// (scripted broker workers, 2026-10-14: 3 of 3 launches and 3 of 3 finishes). The line takes its 20px
// out of the transcript's scroller, so each edge painted twice: the line arriving with no row above it,
// then the row; the line leaving while the row still said running, then the result. A sub-agent's life
// inside a turn drew 5 states in the drawer where 3 say it (its row, its result, the rest), and 6 on the
// 820px page where 4 do.
//
// So while the transcript has not caught up, the line keeps what it was showing: a child the board has
// just added waits for its Agent row, and a child the board has just dropped stays until its row reads
// finished. Only an edge this view watched happen is held — a child already on the board when the view
// mounted is shown as the board has it, since its row may be outside the transcript's window — and never
// for longer than REST_CATCH_UP_MS, so a transcript that never shows a row cannot keep a count wrong.
export type OpsEvidence = Pick<TranscriptMessage, "tools">

/** The Agent rows the transcript holds: every dispatch id it shows, and those whose row reads finished. */
export function transcriptAgents(messages: readonly OpsEvidence[]): { launched: Set<string>; finished: Set<string> } {
  const launched = new Set<string>()
  const finished = new Set<string>()
  for (const m of messages) {
    for (const tool of m.tools) {
      if (!tool.agentId) continue
      launched.add(tool.agentId)
      if (tool.agentStatus) finished.add(tool.agentId)
    }
  }
  return { launched, finished }
}

/** The sub-agents to present: the board's, with each edge the transcript has not reached yet undone
 *  against `shown` — what the view's last commit presented. Returns `board` by identity when nothing is
 *  held, and `key` names the held edges, for the cap. */
export function agentsAhead(
  board: readonly SubAgentView[],
  shown: readonly SubAgentView[],
  messages: readonly OpsEvidence[],
): { agents: readonly SubAgentView[]; key: string | undefined } {
  if (messages.length === 0) return { agents: board, key: undefined }
  const { launched, finished } = transcriptAgents(messages)
  const shownIds = new Set(shown.flatMap((agent) => (agent.id ? [agent.id] : [])))
  const boardIds = new Set(board.flatMap((agent) => (agent.id ? [agent.id] : [])))
  // Arrived on the board, not yet in the transcript.
  const early = board.filter((agent) => agent.id && !shownIds.has(agent.id) && !launched.has(agent.id))
  // Gone from the board, still running in the transcript.
  const kept = shown.filter((agent) => agent.id && !boardIds.has(agent.id) && launched.has(agent.id) && !finished.has(agent.id))
  if (early.length === 0 && kept.length === 0) return { agents: board, key: undefined }
  const key = [...early.map((agent) => `+${agent.id}`), ...kept.map((agent) => `-${agent.id}`)].join(" ")
  return { agents: [...board.filter((agent) => !early.includes(agent)), ...kept], key }
}

/** The thread as the op counts should present it: the board's, unless agentsAhead holds an edge back
 *  for at most REST_CATCH_UP_MS. Returned by identity whenever nothing is held. */
export function useOpsHeldForTranscript(t: ThreadView | undefined, messages: readonly OpsEvidence[]): ThreadView | undefined {
  // What the LAST COMMIT presented, or undefined before the first: read during render, written after
  // commit, so a child already there when the view mounted is never held back.
  const shown = useRef<readonly SubAgentView[] | undefined>(undefined)
  const [expired, setExpired] = useState<string | undefined>(undefined)
  const board = t?.subAgents ?? []
  const ahead = shown.current === undefined ? { agents: board, key: undefined } : agentsAhead(board, shown.current, messages)
  const key = ahead.key
  useEffect(() => {
    if (key === undefined) return
    const timer = setTimeout(() => setExpired(key), REST_CATCH_UP_MS)
    return () => clearTimeout(timer)
  }, [key])
  const held = key !== undefined && expired !== key
  const agents = held ? ahead.agents : board
  useEffect(() => {
    shown.current = agents
  }, [agents])
  return !t || agents === board ? t : { ...t, subAgents: [...agents] }
}
