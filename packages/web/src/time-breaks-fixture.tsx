import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for TIME BREAKS (lib/timeBreaks): the centred `Today 10:51 AM` reading the virtualized
// transcript draws where a day starts or 20m+ pass between messages. The excerpt is the one that
// prompted them — two split sends, an agent reply, and a send half an hour later — preceded by a
// stretch from YESTERDAY, so a day break, a same-day time break and a burst with no break all show.
// Instants are relative to the real clock so "Today" and "Yesterday" read true whenever this is opened.
//
//   nubx vite --port 5478 --strictPort      (from packages/web)
//   http://localhost:5478/time-breaks-fixture.html
//
//   ?surface=card   the same thread on its QUEUE CARD. A card draws a window of the transcript — from the
//                   human's last ask — and its first dated row names the day, as the thread view's does.
//   ?variant=park   a turn, a rest, and a background wake two and a half hours later that resumes it. The
//                   wake's row carries the break on both surfaces.
//   ?variant=rounds three runs, so the card folds the middle one behind its "more rounds" divider. The
//                   breaks on the rows it hides are carried to the next row it draws (carryTimeBreak).

const SLUG = "time-breaks"
document.documentElement.dataset.font = new URLSearchParams(location.search).get("font") === "mono" ? "mono" : "sans"

const thread = {
  id: SLUG,
  title: "Encrypt the token file at rest",
  status: "needs-human",
  statusText: "Waiting on your call",
  mechanism: null,
  humanBlocked: true,
  needsYou: true,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "idle",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  subAgents: [],
  bgShells: [],
  lastActivityAt: "2026-07-18T10:00:00.000Z",
  spawnedAt: "2026-07-18T09:00:00.000Z",
  // The push-now click resolves this at CLICK time and refuses without it, so the control is only
  // driveable here if the fixture thread carries one — same as any live row.
  sessionId: "sid-time-breaks",
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const today = new Date()
const on = (daysAgo: number, h: number, m: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, h, m).toISOString()
const user = (id: string, at: string, text: string) => ({ sourceId: id, role: "user", text, tools: [], parts: [], at })
const agent = (id: string, at: string, text: string) => ({ sourceId: id, role: "assistant", text, tools: [], parts: [{ kind: "text", text }], at })

const tool = (name: string, detail: string) => ({ name, status: "completed", detail })
const worked = (id: string, at: string, text: string, tools: ReturnType<typeof tool>[]) => ({ sourceId: id, role: "assistant", text, tools, parts: [{ kind: "tools", tools }, { kind: "text", text }], at })
const boundary = (id: string, at: string, kind: "rest" | "wake", text: string) => ({ sourceId: id, role: "assistant", kind: "event", boundary: kind, text, tools: [], parts: [], at })

const park = [
  user("u0", on(0, 9, 40), "Kick off the release workflow and watch it."),
  worked("a0", on(0, 9, 41), "Starting the workflow, then I'll sit on the run until it reaches a terminal state.", [tool("Bash", "gh workflow run release.yml")]),
  agent("a1", on(0, 9, 42), "The workflow is running; I'll report when the watcher returns."),
  boundary("r0", on(0, 9, 42), "rest", "Agent rested"),
  boundary("w0", on(0, 12, 7), "wake", "Background task «Watching the release run» exited 0"),
  worked("a2", on(0, 12, 8), "The watcher came back green — checking what the run actually published.", [tool("Bash", "gh run view 8891241 --json conclusion"), tool("Bash", "gh release view v2.4.0")]),
  agent("a3", on(0, 12, 11), "Both packages are published and the tag points at the commit that was tested."),
  boundary("r1", on(0, 12, 11), "rest", "Agent rested"),
]

const rounds = [
  ...park.slice(0, 4),
  boundary("w0", on(0, 10, 30), "wake", "Background task «Watching the typecheck» exited 0"),
  worked("b0", on(0, 10, 31), "Typecheck is green. Waiting on the publish step now.", [tool("Bash", "gh run view 8891241 --json jobs")]),
  boundary("rb", on(0, 10, 31), "rest", "Agent rested"),
  boundary("w1", on(0, 12, 7), "wake", "Background task «Watching the release run» exited 0"),
  worked("a2", on(0, 12, 8), "The watcher came back green — checking what the run actually published.", [tool("Bash", "gh run view 8891241 --json conclusion"), tool("Bash", "gh release view v2.4.0")]),
  agent("a3", on(0, 12, 11), "Both packages are published and the tag points at the commit that was tested."),
  boundary("r1", on(0, 12, 11), "rest", "Agent rested"),
]

const PARAMS = new URLSearchParams(location.search)
const split = [
  user("u0", on(1, 15, 2), "Can you check whether the relay token file is encrypted at rest?"),
  agent("a0", on(1, 15, 3), "It is not — `~/.frizz/relay-token` is plain text at `0600`. Encrypting it means a keychain read on every boot."),
  user("u1", on(0, 10, 51), "I don't want to give you m"),
  user("u2", on(0, 10, 51), "y macOS password."),
  agent("a1", on(0, 10, 52), "That's fine — the keychain read needs it once per boot, so the fallback is to skip encryption at rest and keep the token file at `0600`."),
  user("u3", on(0, 11, 24), "maybe its not worth encrypting"),
]
const messages = (PARAMS.get("variant") === "park" ? park : PARAMS.get("variant") === "rounds" ? rounds : split) as unknown as TranscriptMessage[]

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : ((input as Request).url ?? input.toString()), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(
      JSON.stringify({ result: { messages, transcriptKey: `${SLUG}-key`, hasEarlier: false, historyLoaded: true } }),
      { headers: { "content-type": "application/json" } },
    )
  }
  // An answered-questions list is a list, and an empty object for it is a page error on every load.
  if (url.pathname === "/_frizz/rpc/threadSettledQuestions") {
    return new Response(JSON.stringify({ result: { questions: [] } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      {PARAMS.get("surface") === "card" ? (
        <div className="mx-auto w-[min(680px,calc(100%-32px))] py-8 text-sm">
          <TodosView />
        </div>
      ) : (
        <div className="relative h-screen bg-bg text-fg text-sm">
          <div className="mx-auto flex h-screen w-[760px] max-w-full flex-col border-x border-border">
            <ThreadView slug={SLUG} virtualized />
          </div>
        </div>
      )}
    </TooltipProvider>
  </QueryClientProvider>,
)
