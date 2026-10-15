import type { BgShellView, ThreadView } from "@frizz/shared"
import type { TranscriptShellRecord } from "./childOps.ts"
import { threadOps } from "./threadOps.ts"

export type QueueOpsKind = "agent" | "shell" | "pr" | "issue" | "command" | "timer" | "file" | "link"

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
// The line counts what its panels list, which is every WAIT the thread has: the steps card draws none of
// its rows and points the reader here instead (AwaitingBackgroundCard), so a kind with no count is a wait
// shown nowhere. The command watches and timers joined on 2026-10-15 for that reason. The rail lists one
// thing more, the files the worker edited, which are not a wait.
export function queueOpsCounts(thread: ThreadView, transcriptShells: readonly (BgShellView & TranscriptShellRecord)[] = []): QueueOpsCount[] {
  const { agents, shells, prs, issues, commands, timers, files, links } = threadOps(thread, transcriptShells)
  const counts: QueueOpsCount[] = [
    { key: "agent", n: agents.length, one: "agent", many: "agents", states: agents.map((agent) => agent.state) },
    { key: "shell", n: shells.length, one: "shell", many: "shells", states: shells.map((shell) => shell.state) },
    { key: "pr", n: prs.length, one: "PR", many: "PRs", states: ["running"] },
    { key: "issue", n: issues.length, one: "issue", many: "issues", states: ["running"] },
    // Parked waits, live as a PR watch is, and drawn in its hue (ChildOpRow).
    { key: "command", n: commands.length, one: "command", many: "commands", states: ["running"] },
    { key: "timer", n: timers.length, one: "timer", many: "timers", states: ["running"] },
    { key: "file", n: files.length, one: "file", many: "files", states: [] },
    { key: "link", n: links.length, one: "link", many: "links", states: [] },
  ]
  return counts.filter((count) => count.n > 0)
}
