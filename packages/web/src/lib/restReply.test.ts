import { test } from "node:test"
import assert from "node:assert/strict"
import type { ChatMessage } from "../hooks.ts"
import { inQueuedTail, restReplyIndex, withRestReplyInline } from "./restReply.ts"
import { withoutRedundantRestDividers } from "./restDividers.ts"
import { buildVirtualTranscriptMessageRows } from "./virtualTranscript.ts"

const msg = (over: Partial<ChatMessage>): ChatMessage =>
  ({ sourceId: over.sourceId, role: "assistant", text: "", tools: [], parts: [], ...over }) as ChatMessage

const prose = (id = "a") => msg({ sourceId: id, text: "Fixed — landed on main.", at: "2026-10-13T10:00:00.000Z" })
const rest = (id = "r") => msg({ sourceId: id, kind: "event", boundary: "rest", text: "Agent rested", at: "2026-10-13T10:00:01.000Z" })
const landed = (id = "u") => msg({ sourceId: id, role: "user", text: "Done", at: "2026-10-13T11:00:00.000Z" })
// The optimistic copy appendQueuedMessage writes: no sourceId, no instant.
const ghost = (over: Partial<ChatMessage> = {}) => msg({ role: "user", text: "Done", queued: true, ...over })
const SENT = "2026-10-13T11:00:00.000Z"

test("the first queued send after the closing rest is that rest's reply", () => {
  assert.equal(restReplyIndex([prose(), rest(), ghost()]), 2)
  // The server's own queued copy of it counts the same as the optimistic one.
  assert.equal(restReplyIndex([prose(), rest(), ghost({ sourceId: "srv", deliveryState: "sending" })]), 2)
})

test("a send into a running turn is not — the agent has said something since its last rest", () => {
  assert.equal(restReplyIndex([prose(), ghost()]), -1)
  assert.equal(restReplyIndex([prose(), rest(), landed(), prose("a2"), ghost()]), -1)
})

test("only the FIRST send answers the rest; one after it is queued behind the turn it started", () => {
  assert.equal(restReplyIndex([prose(), rest(), landed(), ghost()]), -1)
  assert.equal(restReplyIndex([prose(), rest(), ghost(), ghost({ text: "and another" })]), 2)
})

test("a wake, a peer's message or an instruction that got there first means the agent is not resting on the human", () => {
  for (const first of [
    msg({ role: "user", wake: true, text: "…sign off…" }),
    msg({ role: "user", peerFrom: "other-thread", text: "from a peer" } as Partial<ChatMessage>),
    msg({ role: "user", agentInstruction: true, text: "instruction" } as Partial<ChatMessage>),
  ]) assert.equal(restReplyIndex([prose(), rest(), first, ghost()]), -1)
})

test("a failed, unconfirmed or held send stays in the queued tail", () => {
  for (const deliveryState of ["failed", "unconfirmed", "held"] as const) {
    assert.equal(restReplyIndex([prose(), rest(), ghost({ deliveryState })]), -1)
  }
})

test("the reply is marked inline and stamped with the send's instant; nothing to mark returns the list itself", () => {
  const list = [prose(), rest(), ghost()]
  const marked = withRestReplyInline(list, SENT)
  assert.equal(marked[2].restReply, true)
  assert.equal(marked[2].queued, true, "it still renders as a ghost")
  assert.equal(marked[2].at, SENT)
  assert.equal(list[2].restReply, undefined, "the cache's own object is never written")
  assert.equal(inQueuedTail(marked[2]), false)
  // A copy the server stamped keeps its own instant.
  assert.equal(withRestReplyInline([prose(), rest(), ghost({ at: "2026-10-13T11:00:02.000Z" })], SENT)[2].at, "2026-10-13T11:00:02.000Z")
  const running = [prose(), ghost()]
  assert.equal(withRestReplyInline(running, SENT), running)
  assert.equal(inQueuedTail(running[1]), true)
})

// THE INVARIANT the module exists for: the ghost lays out exactly as the echo will — same rows, same
// hairline — so the echo changes the bubble's opacity and nothing else.
test("the inline reply draws the same rows and the same rest hairline as its landed copy", () => {
  const rendersNothing = () => false
  const gap = () => 14
  const shape = (messages: ChatMessage[]) => {
    const kept = withoutRedundantRestDividers(messages.map((message, i) => ({ message, messageIndex: i })), rendersNothing).map((e) => e.message)
    return buildVirtualTranscriptMessageRows(kept, rendersNothing, gap).map((row) => `${row.message.role}${row.message.kind ? `/${row.message.kind}` : ""}+${row.gap}`)
  }
  const before = shape(withRestReplyInline([prose(), rest(), ghost()], SENT))
  const after = shape([prose(), rest(), landed()])
  assert.deepEqual(before, after)
  assert.deepEqual(after, ["assistant+0", "assistant/event+14", "user+14"])
  // …whereas a ghost left in the tail drew neither the hairline nor a row of its own.
  assert.deepEqual(shape([prose(), rest(), ghost()]), ["assistant+0"])
})
