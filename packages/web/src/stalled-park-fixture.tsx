import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the stall reason on the queue's resting card (board.parkStall, 2026-10-27). Two queued
// `status: watching` parks, each in the shape the board emits once it refuses to honour the park:
//   A  a PR park whose PR is green, mergeable and only waits on our merge   → stalledPark.why "pr-idle"
//   B  a timer loop that has re-parked six times over two days              → stalledPark.why "repeated"
// `?w=<px>` narrows the column, for the queue's narrowest card.

const HOUR = 3_600_000
const now = Date.now()
const iso = (ms: number) => new Date(now - ms).toISOString()

const base = {
  kind: "session", state: "open", status: "active", mechanism: null, backend: "codex", permissionMode: "default",
  humanBlocked: false, pendingQuestion: false, crashed: false, archived: false, foreign: false, ready: false,
  unread: false, hasPlan: false, dependsOn: [], externalDeps: [], agents: [], errors: [], warnings: [],
  subAgents: [], bgShells: [], needsYou: true, awaitingBackground: true, runtime: "turn-idle",
  spawnedAt: iso(80 * HOUR),
} as const

const prIdle = {
  ...base,
  id: "linked-file-warnings",
  title: "Track linked-file warning PR",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000001",
  lastFence: {
    kind: "awaiting",
    body: "",
    hints: [{ kind: "pr", value: "inkeep/agents-private#7438" }, { kind: "status", value: "watching" }, { kind: "for", value: "180d" }],
  },
  watches: [{
    id: "github:linked-file-warnings:inkeep/agents-private#7438", kind: "github", target: "inkeep/agents-private#7438",
    state: "armed", createdAt: iso(42 * HOUR),
    github: {
      checks: "passing", running: 0, passed: 85, failed: 0, skipped: 30, gated: 0, gating: [], failing: [],
      merge: "mergeable", state: "open", polledAt: iso(0), mergePath: "none", viewerAuthored: true, viewerCanMerge: true,
    },
  }],
  stalledPark: { why: "pr-idle", refs: ["inkeep/agents-private#7438"] },
  lastActivityAt: iso(42 * HOUR),
  lastUserAt: iso(42 * HOUR),
} as unknown as ThreadView

const repeated = {
  ...base,
  id: "t9-grant-poll",
  backend: "claude",
  title: "Ubuntu git recovery metadata observation",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000002",
  lastFence: {
    kind: "awaiting",
    body: "",
    hints: [{ kind: "timer", value: "tmr_79c8b08e5f09" }, { kind: "status", value: "watching" }, { kind: "for", value: "1d" }],
  },
  watches: [{
    id: "timer:t9-grant-poll:tmr_79c8b08e5f09", kind: "timer", target: "tmr_79c8b08e5f09", state: "armed",
    createdAt: iso(2 * HOUR),
    timer: { fireAt: new Date(now + 22 * HOUR).toISOString(), prompt: "Fallback: check for a reply or new grant from root, else re-park." },
  }],
  stalledPark: { why: "repeated", parks: 6, since: iso(50 * HOUR) },
  lastActivityAt: iso(2 * HOUR),
  lastUserAt: iso(2 * HOUR),
} as unknown as ThreadView

store.board = { projectDir: "/fixture/open-knowledge", threads: [prIdle, repeated] } as unknown as BoardSnapshot
store.drawers = []

const empty = { messages: [], transcriptKey: "fixture-key", hasEarlier: false, historyLoaded: false }
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(JSON.stringify({ result: empty }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  return originalFetch(input, init)
}

const width = Number(new URLSearchParams(location.search).get("w")) || 680
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <div className="mx-auto py-8" style={{ width: `min(${width}px, calc(100% - 32px))` }}>
        <TodosView />
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
)
