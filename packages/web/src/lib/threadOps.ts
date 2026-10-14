import type { BgShellView, SubAgentView, ThreadLinkView, ThreadView, ThreadWatchView } from "@frizz/shared"
import { mergeBackgroundShells, visibleChildOps, type TranscriptShellRecord } from "./childOps.ts"

/** WHAT A THREAD HAS RUNNING, WATCHED OR SAVED — one answer for every place that lists it: the line of
 *  counts over the prompt box (lib/queueOpsCounts), the panel each count opens (QueueSubAgentLines,
 *  BackgroundOpsStrip), and the full-screen page's rail (FocusRail). Those picked their rows by rules of
 *  their own until 2026-10-14, and the rules had drifted: the rail left out an archived thread's watches
 *  and every watch no longer armed — a past-due timer read "firing…" forever there, and a PR row froze on
 *  its last reading — while the line over the prompt box went on counting both. */
export interface ThreadOps {
  /** Every child still unresolved — running, rested or stale — at every depth (visibleChildOps "card"). */
  agents: readonly SubAgentView[]
  /** The board's shells and the transcript's, one row per process (mergeBackgroundShells). */
  shells: readonly BgShellView[]
  prs: readonly ThreadWatchView[]
  issues: readonly ThreadWatchView[]
  commands: readonly ThreadWatchView[]
  timers: readonly ThreadWatchView[]
  /** What the worker saved for the human (`frizzctl link`), split by kind. */
  files: readonly ThreadLinkView[]
  links: readonly ThreadLinkView[]
}

/** `transcriptShells` are the shells read off the transcript, whose Codex background execs the board
 *  reports none of (ChatView transcriptBackgroundShells); every caller passes them.
 *
 *  A WATCH IS LISTED WHILE IT IS ARMED AND ITS THREAD IS NOT ARCHIVED. An archived thread watches nothing,
 *  though its registrations stay armed for the day it is reopened: the scheduler neither fires its timers
 *  nor polls its PRs and issues (scheduler.ts evalTimers, and the per-watcher liveness skip). A SHELL watch
 *  is never a row of its own: the shell it waits on is already one, and listing the watch too would name
 *  one process twice (2026-08-14); BackgroundOpsStrip marks it on that shell's row instead. */
export function threadOps(thread: ThreadView, transcriptShells: readonly (BgShellView & TranscriptShellRecord)[] = []): ThreadOps {
  const watching = thread.state !== "archived"
  const armed = (thread.watches ?? []).filter((watch) => watching && watch.state === "armed")
  const github = armed.filter((watch) => watch.kind === "github")
  const saved = thread.links ?? []
  return {
    agents: visibleChildOps(thread.subAgents ?? [], "card"),
    shells: mergeBackgroundShells(thread.bgShells ?? [], transcriptShells),
    prs: github.filter((watch) => watch.subject !== "issue"),
    issues: github.filter((watch) => watch.subject === "issue"),
    commands: armed.filter((watch) => watch.kind === "command"),
    timers: armed.filter((watch) => watch.kind === "timer"),
    files: saved.filter((link) => link.kind === "file"),
    links: saved.filter((link) => link.kind === "link"),
  }
}
