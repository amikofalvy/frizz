import type { ChatMessage } from "../hooks.ts"

// THE LAST THING THE AGENT SAID. Any ```awaiting fence above it states a wait that has already resolved —
// the worker spoke again, so whatever it named came back or was given up on — and draws nothing at all
// (see ChatView's renderText). Every transcript surface cuts at this index, so the scan lives in one
// place and the thread surface asks it once for all of them (components/ThreadSurface.tsx): when two
// surfaces disagree, one of them either strands a live fence or keeps drawing a settled one.
//
// SAID, NOT "IS THE LAST ASSISTANT ROW". A `kind:"event"` line carries `role:"assistant"` but nothing the
// agent uttered — it is frizz's own synthetic marker for a rest, a wake, a compaction or a sub-agent
// completion. Counting one made the cut land AFTER the fence it was supposed to protect, and every rested
// thread ends with exactly such a row ("Agent rested"), so EVERY live fence read as settled: the card and
// its hourglass came off the one wait that was still open, and its body dropped to free-standing prose.
// That is the "light gray lines" the maintainer kept reporting on threads whose wait had not resolved at
// all (2026-08-20), and it survived being restyled twice because the tone was never the defect. Reasoning
// is the model's OWN output and still counts: a worker that wakes and thinks has resumed.
export function lastAssistantIndex(messages: readonly Pick<ChatMessage, "role" | "kind">[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant" && messages[i].kind !== "event") return i
  return -1
}
