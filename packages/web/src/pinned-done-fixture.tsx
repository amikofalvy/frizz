import { createRoot } from "react-dom/client"
import { useEffect, useState } from "react"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { FenceCard, ThreadSlugContext } from "./components/ChatView.tsx"
import { ThreadLifecycleActions } from "./components/ThreadLifecycle.tsx"
import { Toaster } from "./components/Toaster.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { setBoard } from "./store.ts"
import "./styles.css"

// Mark as done UNPINS by default. Renders the REAL done card and header check for a pinned and an
// unpinned thread against a mocked RPC that answers as the server does: a pinned thread's completion
// lifts its pins and hands them back, unless `keepPinned`. The toast's "Keep pinned" calls setThreadPinned
// with the old instant. Nothing real is hit.
const PINNED_AT = "2026-10-01T09:00:00.000Z"
const nativeFetch = window.fetch.bind(window)
const rpcResult = (result: unknown) => new Response(JSON.stringify({ result }), {
  headers: { "content-type": "application/json", "x-frizz-boot": "pinned-done-fixture" },
})

window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.toString(), window.location.origin)
  const name = url.pathname.replace("/_frizz/rpc/", "")
  if (name === "completeThread" || name === "setThreadPinned" || name === "setThreadConsolePinned") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { slug?: string; keepPinned?: boolean }
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: `${name}(${JSON.stringify(body)})` }))
    if (name !== "completeThread") return rpcResult(null)
    const pinned = body.slug === "pinned" && body.keepPinned !== true
    return rpcResult(pinned ? { needsConfirmation: false, unpinned: { pinnedAt: PINNED_AT, consolePinnedAt: null } } : { needsConfirmation: false })
  }
  return nativeFetch(input, init)
}

const thread = (id: string, title: string, extra: Partial<ThreadView> = {}): ThreadView => ({
  id,
  title,
  status: "active",
  mechanism: null,
  humanBlocked: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "turn-idle",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  sessionId: `sid-${id}`,
  subAgents: [],
  bgShells: [],
  watches: [],
  questions: [],
  ...extra,
})

const board: BoardSnapshot = {
  projectDir: "/tmp/fixture",
  projectName: "fixture",
  projectLabel: "fixture/fixture",
  threads: [thread("pinned", "Resolver cache keyed on the normalized id", { pinnedAt: PINNED_AT }), thread("loose", "Retry backoff for the flaky upload")],
  errors: [],
  warnings: [],
}
setBoard(board)

function Fixture() {
  const [calls, setCalls] = useState<string[]>([])
  useEffect(() => {
    const onRpc = ((event: CustomEvent<string>) => setCalls((prior) => [...prior, event.detail])) as EventListener
    window.addEventListener("fixture-rpc", onRpc)
    return () => window.removeEventListener("fixture-rpc", onRpc)
  }, [])
  return (
    <TooltipProvider>
      <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-5 px-4 py-8">
        {board.threads.map((t) => (
          <section key={t.id} data-fixture={t.id} className="flex flex-col gap-2">
            <div className="flex items-center justify-between rounded-md border border-border bg-panel px-3 py-1.5">
              <span className="text-[12px] text-muted">{t.pinnedAt ? "Pinned thread — header" : "Unpinned thread — header"}</span>
              <ThreadLifecycleActions thread={t} />
            </div>
            <ThreadSlugContext.Provider value={t.id}>
              <FenceCard fenceKind="done" body="Fixed the cache collision in `src/resolver.ts`; the lookup now keys on the normalized id." hints={[]} />
            </ThreadSlugContext.Provider>
          </section>
        ))}
        <p data-fixture-rpc-calls className="text-[11px] text-muted">RPC calls: {calls.join(" | ") || "none"}</p>
      </main>
      <Toaster />
    </TooltipProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
