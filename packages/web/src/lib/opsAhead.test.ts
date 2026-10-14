import assert from "node:assert/strict"
import { test } from "node:test"
import type { SubAgentView } from "@frizz/shared"
import { agentsAhead, transcriptAgents, type OpsEvidence } from "./opsAhead.ts"

const agent = (id: string) => ({ id, description: id }) as unknown as SubAgentView
const launched = (id: string, status?: string): OpsEvidence => ({ tools: [{ agentId: id, agentStatus: status }] }) as unknown as OpsEvidence
const prose: OpsEvidence = { tools: [] } as unknown as OpsEvidence

test("the transcript's Agent rows name what launched and what finished", () => {
  const { launched: l, finished: f } = transcriptAgents([launched("a"), launched("b", "completed"), prose])
  assert.deepEqual([...l], ["a", "b"])
  assert.deepEqual([...f], ["b"])
})

test("a child the board reports before its Agent row waits for the row", () => {
  const board = [agent("a")]
  const held = agentsAhead(board, [], [prose])
  assert.deepEqual(held.agents, [])
  assert.equal(held.key, "+a")
  // The row lands: the board's list is presented as it is, by identity.
  const caught = agentsAhead(board, [], [prose, launched("a")])
  assert.equal(caught.agents, board)
  assert.equal(caught.key, undefined)
})

test("a child the board drops while its row still reads running stays until the row finishes", () => {
  const shown = [agent("a")]
  const held = agentsAhead([], shown, [launched("a")])
  assert.deepEqual(held.agents.map((a) => a.id), ["a"])
  assert.equal(held.key, "-a")
  assert.equal(agentsAhead([], shown, [launched("a", "completed")]).key, undefined)
})

test("an edge the view never saw is not held", () => {
  // Already presented: a board that keeps it is not an edge.
  const board = [agent("a")]
  assert.equal(agentsAhead(board, board, [prose]).agents, board)
  // Dropped from the board, but its row is outside the transcript's window: nothing to wait for.
  assert.deepEqual(agentsAhead([], [agent("a")], [prose]).agents, [])
  // No transcript at all yet: present the board.
  assert.equal(agentsAhead(board, [], []).agents, board)
})
