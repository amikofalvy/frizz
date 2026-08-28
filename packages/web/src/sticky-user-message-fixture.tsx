import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { ThreadView, FenceCard, Message } from "./components/ChatView.tsx"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { prefs } from "./lib/prefs.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the sticky most-recent-user-message change: the human's latest ask pins to the top
// of the scroll pane in BOTH the drawer (ChatView) and the queue card (TodosView), with top padding
// and a max-height that gives a very tall ask its own internal scroll.
//   ?surface=queue|drawer   which surface to render (default queue)
//   ?size=short|tall|wake   short one-line ask; a very tall ask (exercise max-h + inner scroll); or a
//                           tall SCHEDULER WAKE landing after the human's ask — frizz's own turn, which
//                           is NOT the current ask and so must never take the pin (lastAskIndex).
//                           `?size=answers` pins the OTHER thing that can be the current ask — the
//                           human's composed multi-block answer, which renders as AnswersCard rather
//                           than a bubble and collapses on the same four-line rule.
//                           QA `?size=wake` on BOTH surfaces: each pins from its own call site, and
//                           they carried this defect independently until both were pointed at
//                           lastAskIndex.
//   ?sticky=on|off  the client stickyUserMessage view pref. Pinned ON by default HERE (the app's own
//                   default is off) — this fixture exists to QA the pinned band, so it must show one.
//   ?font=mono      this app renders in TWO type families (html[data-font], applied before first paint)
//                   and the collapsed cap is `4lh` — one line box of the RESOLVED font — so the band is
//                   a different height in each. Defaults to `sans`, index.html's own default; a fixture
//                   that leaves data-font unset silently renders mono and measures the wrong band.
//   ?img=<abs path> attach that picture to the pinned ask (repeatable, comma-separated). The
//                   attachments render OUTSIDE the bubble, so they are capped separately from the
//                   prose — collapsed they are a row of thumbnails, hovered they return to full size.
//                   Load through the adhoc stack, whose /local-image serves os.tmpdir().
const params = new URLSearchParams(location.search)
const surfaceParam = params.get("surface")
const surface = surfaceParam === "drawer" ? "drawer" : surfaceParam === "fence" ? "fence" : surfaceParam === "sentfiles" ? "sentfiles" : "queue"
const sizeParam = params.get("size")
const size = sizeParam === "tall" ? "tall" : sizeParam === "medium" ? "medium" : sizeParam === "wake" ? "wake" : sizeParam === "answers" ? "answers" : "short"
prefs.stickyUserMessage = params.get("sticky") !== "off"
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"

const SLUG = "sticky-demo"

const shortAsk =
  "Can you make the most recent user message sticky at the top of the thread UI, with padding?"
// Medium: taller than the 200px collapsed cap but SHORTER than the 85vh expand cap — the case the
// reported reflow bug lived in (hover expands to fit, a transient scrollbar used to flash mid-animation).
const mediumAsk = Array.from({ length: 8 }, (_, i) =>
  `Line ${i + 1}: a medium-length ask that comfortably fits when expanded, so hovering it should reveal the whole message with no scrollbar and no reflow at all.`,
).join("\n")
const tallAsk = Array.from({ length: 30 }, (_, i) =>
  `Line ${i + 1}: this is a deliberately very tall user message so the pinned band exceeds the pane height and must scroll within its own max-height instead of swallowing the whole viewport.`,
).join("\n")
// The wire form useLiveAnswering.sendAnswers writes for a multi-block answer, which parseAnswersCard
// turns back into the structured card. Long free-text answers are the case that made it uncappable.
const answersAsk = [
  "Answers:",
  ...Array.from({ length: 5 }, (_, i) =>
    `${i + 1}. Option ${String.fromCharCode(65 + i)} — and a long free-text rider on top of the choice, because an answer block accepts continuation lines and pasted paragraphs, which is exactly how this card grew past the pane.`),
].join("\n")
const askFor = (s: typeof size) => (s === "tall" ? tallAsk : s === "medium" ? mediumAsk : s === "answers" ? answersAsk : shortAsk)

// A WAKE FRIZZ DELIVERED, in the shape that broke this band: a worker's own scheduled prompt, pasted
// back in. It is recorded as a `user` turn because frizz pastes it into the worker's composer, so
// `wake` is the server's tell that frizz — not the human — wrote it.
//
// No parser in FrizzWake recognizes this text, so it takes the unstructured fallback: a full
// TranscriptCard holding the WHOLE delivered prompt, with no height cap and no `sticky` handling.
// Pinned, that card floated over the entire transcript. The wakes that DO parse (a fired timer with its
// trailer, a PR poll, a shell finishing) draw a one-line divider instead — a quieter symptom of the
// identical defect, since a hairline pinned in the ask band is still standing where the human's
// instruction should be. Both are excluded by the same guard.
const unparsedWake = [
  "PRD-8179 ceiling follow-up / PR #3787 check-in. Worktree `.claude/worktrees/prd-8179-ax-mode-instrumentation`, branch `fix/prd-8179-pin-annotation-ceiling`, HEAD 9d2de14e74 (3 commits, TESTS + COMMENTS ONLY).",
  "REVIEW LOOP IS CLOSED. The 23:15Z review was APPROVE WITH SUGGESTIONS (Risk: Low), its single Minor is fixed in the final commit, and its two other items were self-discarded as pre-existing and out of scope. DO NOT start another polish round.",
  "1. `gh pr view 3787 --json state,mergedAt,mergeStateStatus` + queue timeline.\n   - MERGED → check for any review newer than 2026-08-21T23:15:48Z. If nothing Major landed: drop the watcher and sign off.\n   - still queued / CI pending → set a NEW ~45min timer and name the PR AND the new timer id. A fired one-shot is spent.\n   - `removed_from_merge_queue` → DO NOT REBASE; the queue is ALLGREEN/max-5, so another PR's failure dequeues the whole group.",
  "PUSH-LOCK: dequeue via `gh api graphql`, push, then re-arm `gh pr merge 3787 --squash --auto`.",
  "Node 24: export PATH=\"/Users/you/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH\". Never run lint and the full test suite concurrently.",
].join("\n\n")

const longReply = Array.from({ length: 40 }, (_, i) =>
  `**Paragraph ${i + 1}.** The assistant reply is intentionally long so the pane scrolls and the pinned ask stays visible above it. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
).join("\n\n")

// The composer parks attachments as TRAILING standalone absolute-path lines and the bubble peels them
// back off (splitComposerValue), so a fixture attachment is spelled exactly the way a real send is.
const askImages = (params.get("img") ?? "").split(",").map((p) => p.trim()).filter(Boolean)
const withAttachments = (prose: string) => [prose, ...askImages].join("\n")

const messages: TranscriptMessage[] = [
  { sourceId: "u0", role: "user", text: "First, an older ask that should scroll away normally.", tools: [], parts: [] },
  { sourceId: "a0", role: "assistant", text: "Sure — here is an earlier reply.", tools: [], parts: [{ kind: "text", text: "Sure — here is an earlier reply." }] },
  // THE PINNED ASK. Under `?size=answers` its text is the answers wire form, so it renders as
  // AnswersCard rather than a bubble — unpaired with any question, which is all this fixture needs.
  { sourceId: "u1", role: "user", text: withAttachments(askFor(size === "wake" ? "short" : size)), tools: [], parts: [] },
  { sourceId: "a1", role: "assistant", text: longReply, tools: [], parts: [{ kind: "text", text: longReply }] },
  // The wake lands LAST, after the reply — exactly where a delivered wake lands. The human's ask above it
  // must keep the pin, and this card must stay in the flow at the bottom of the transcript.
  ...(size === "wake"
    ? [{ sourceId: "w1", role: "user", text: unparsedWake, wake: true, tools: [], parts: [] } as TranscriptMessage]
    : []),
]

const thread: ThreadViewModel = {
  id: SLUG,
  title: "Sticky most-recent-user-message demo",
  status: "needs-human",
  statusText: "Waiting on your review of the sticky behavior",
  mechanism: null,
  humanBlocked: false,
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
  lastActivityAt: new Date().toISOString(),
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const transcriptPage = { messages, transcriptKey: "fixture-key", hasEarlier: false, historyLoaded: false }

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(JSON.stringify({ result: transcriptPage }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

function DrawerHarness() {
  // A fixed-height flex column mimicking the drawer's shell so ChatView's single scroll region engages.
  return (
    <div className="mx-auto my-8 flex h-[640px] w-[460px] flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-2xl">
      <ThreadView slug={SLUG} />
    </div>
  )
}

// A done-fence body exercising the inline markdown a worker would write: `inline code` for paths /
// identifiers / CSS vars / commands, a [markdown link](url), and **bold**.
const fenceBody = [
  "- Fixed the over-cap scroll in `ui/packages/web/src/components/ChatView.tsx` (`UserBubble` stays `overflow-hidden` while animating).",
  "- Linked the scrollbar width into `:root { --sbw }` so `::-webkit-scrollbar` and the reserved gutter can't drift.",
  "- Opened [PR #391](https://github.com/acme/app/pull/391); ran `pnpm test` and `npm run lint` — **all green**.",
].join("\n")

// A SendUserFile delivery message → renders the SentFilesCard. `?img=<abs path>` supplies a servable
// image (load this fixture through the adhoc stack, whose /local-image serves os.tmpdir()).
const sentImg = params.get("img")
const sentFilesMessage: TranscriptMessage = {
  sourceId: "sf1", role: "assistant", text: "", tools: [],
  parts: [{
    kind: "tools",
    tools: [{
      name: "SendUserFile", detail: "before vs after",
      sentImages: sentImg ? [sentImg] : [],
      sentFiles: ["/Users/you/project/report.md", "/Users/you/project/trace.log"],
      caption: "Left is collapsed, right expands on hover — no reflow. Plus a couple of non-image files.",
    }],
  }],
} as unknown as TranscriptMessage

function Fixture() {
  if (surface === "sentfiles") {
    return (
      <div className="mx-auto mt-10 w-[min(680px,calc(100%-32px))]">
        <Message m={sentFilesMessage} />
      </div>
    )
  }
  if (surface === "fence") {
    return (
      <div className="mx-auto mt-10 w-[min(680px,calc(100%-32px))]">
        <FenceCard fenceKind="done" body={fenceBody} hints={[]} />
      </div>
    )
  }
  if (surface === "drawer") return <DrawerHarness />
  return (
    <div className="mx-auto w-[min(680px,calc(100%-32px))]">
      <TodosView />
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)
