import type { BgShellView, ThreadView } from "@frizz/shared"
import type { TranscriptShellRecord } from "./childOps.ts"
import { threadOps } from "./threadOps.ts"

export type QueueOpsKind = "agent" | "shell" | "pr" | "issue" | "file" | "link"

export interface QueueOpsCount {
  readonly key: QueueOpsKind
  readonly n: number
  readonly one: string
  readonly many: string
  // The states of the rows behind the count, which pick its liveness mark. A parked watcher IS live —
  // its row is always `running` (BackgroundOpsStrip) — so a PR or issue count reads as running.
  readonly states: readonly (string | undefined)[]
}

// The counts on the line above a thread's prompt box — the queue card's docked one and the drawer's
// (QueueOpsSummary) — in display order, with the empty kinds dropped. Counted off lib/threadOps, the rows
// its panels and the full-screen rail list, so the line, its panels and the rail cannot disagree about how
// many there are. `transcriptShells` are the shells read off the transcript, whose Codex background execs
// the board reports none of (see mergeBackgroundShells); both surfaces pass them, to the panel too.
//
// The line counts what its panels list. The rail lists more — the timers and command watches the thread
// is waiting on, and the files its worker edited — which have no panel here.
export function queueOpsCounts(thread: ThreadView, transcriptShells: readonly (BgShellView & TranscriptShellRecord)[] = []): QueueOpsCount[] {
  const { agents, shells, prs, issues, files, links } = threadOps(thread, transcriptShells)
  const counts: QueueOpsCount[] = [
    { key: "agent", n: agents.length, one: "agent", many: "agents", states: agents.map((agent) => agent.state) },
    { key: "shell", n: shells.length, one: "shell", many: "shells", states: shells.map((shell) => shell.state) },
    { key: "pr", n: prs.length, one: "PR", many: "PRs", states: ["running"] },
    { key: "issue", n: issues.length, one: "issue", many: "issues", states: ["running"] },
    { key: "file", n: files.length, one: "file", many: "files", states: [] },
    { key: "link", n: links.length, one: "link", many: "links", states: [] },
  ]
  return counts.filter((count) => count.n > 0)
}
