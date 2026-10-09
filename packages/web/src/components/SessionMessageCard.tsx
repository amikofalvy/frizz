// A MESSAGE FROM ANOTHER THREAD — one top-level session's `SendMessage` into this one, most often the
// coordinator thread that spawned it steering its work.
//
// It reached the chat as an ordinary user turn whose text was Claude Code's raw wrapper, so it rendered
// in the human's own right-justified bubble with `<cross-session-message from="uds:/tmp/cc-socks/2908.sock"
// from-name="frizz-11" from-mode="bypass">` printed above the body (maintainer 2026-10-08: "There should
// be a link to the originating thread, and it should not look like fucking XML"). The server now
// unwraps it (`sessionPeer`, displayText = the body) and names the sending thread.
//
// A CARD, NOT A DIVIDER, by the rule FrizzWake follows: a divider is for one line of news, and this
// carries prose someone else wrote that the reader needs in full — it is an instruction this thread
// acted on. Left-aligned, because right-justification is the human's side of the conversation. The
// title is the SENDER, and it links to the sending thread: the in-project link opens it in the drawer
// (thread-links.ts intercepts `/thread/<slug>`), a sender in another project navigates to that board.
import { MessagesSquare } from "lucide-react"
import { useSnapshot } from "valtio"
import type { ThreadView, TranscriptMessage } from "@frizz/shared"
import { CARD_LINK, QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"
import { displayTitle } from "../groups.ts"
import { outerPath, projectHref } from "../lib/base-path.ts"
import { useInnerHtml } from "../lib/innerHtml.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { store, threadBySlug } from "../store.ts"

type SessionPeer = NonNullable<TranscriptMessage["sessionPeer"]>

export function sessionPeerHref(thread: NonNullable<SessionPeer["thread"]>): string {
  return thread.project ? `${projectHref(thread.project)}/thread/${thread.slug}` : outerPath(`/thread/${thread.slug}`)
}

export function SessionMessageCard({ peer, text, queued, sourceId, wrap }: { peer: SessionPeer; text: string; queued?: boolean; sourceId?: string; wrap?: boolean }) {
  const snap = useSnapshot(store)
  const sender = peer.thread
  // A sender on THIS board takes the title the sidebar shows, live — the server's copy is the row's
  // title at read time, which is all it can offer for a thread in another project.
  const local = sender && !sender.project ? (threadBySlug(snap.board as typeof store.board, sender.slug) as ThreadView | undefined) : undefined
  const title = local ? displayTitle(local) : sender?.title
  const html = useMarkdownHtml(text)
  const inner = useInnerHtml(html)
  const label = sender ? (
    <span className="min-w-0">
      Message from{" "}
      <a href={sessionPeerHref(sender)} data-session-peer-link title="Open the thread that sent this" className={CARD_LINK}>
        {title}
      </a>
    </span>
  ) : (
    // Not a Frizz thread, or one that exited before Frizz could trace it: the session's own name is all
    // there is, and it is said as a name rather than dressed up as a link.
    <span className="min-w-0">{peer.name ? `Message from session ${peer.name}` : "Message from another session"}</span>
  )
  return (
    <div data-frizz-msg={sourceId} data-session-message className={`min-w-0 max-w-[85%] ${queued ? "opacity-50" : ""}`}>
      <TranscriptCard icon={MessagesSquare} label={label}>
        <div className={`md-body [overflow-wrap:anywhere]${wrap ? ` ${QUEUE_WRAP}` : ""}`} dangerouslySetInnerHTML={inner} />
      </TranscriptCard>
    </div>
  )
}
