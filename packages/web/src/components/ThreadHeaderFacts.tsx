import type { ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { lastActiveLabelAt } from "../groups.ts"
import { keyProject } from "../lib/threadKey.ts"
import { ProjectSquare } from "./ProjectRail.tsx"
import { LastActive } from "./LastActive.tsx"
import { ContextMeter, hasContextReading } from "./ContextMeter.tsx"

// A THREAD HEADER'S SECOND LINE: the facts about the thread as a whole, in words — "Last active 2m ago ·
// ◔ 74% context". The queue card and the thread header (drawer and /full) both render it, so the two
// cannot drift. The context reading joined "Last active" here on 2026-10-05 when the lifecycle footer
// that carried it went (see ThreadLifecycle.tsx for the top/bottom split).
//
// `empty:hidden`: a thread with no timestamp and no reading draws nothing, and must not leave the line's
// 2px top margin behind.
export function ThreadHeaderFacts({ thread }: { thread: ThreadView }) {
  // On the Console a thread is named by its KEY (lib/threadKey.ts), and the line opens on the project it
  // belongs to — the one thing a card there says that a project's own board never needs to.
  const project = keyProject(thread.id)
  return (
    <HeaderFacts
      data-thread-header-facts=""
      lead={project ? <ThreadProject slug={project} /> : null}
      lastActiveAt={lastActiveLabelAt(thread)}
      fallbackAt={thread.spawnedAt}
      reading={hasContextReading(thread) ? <ContextMeter thread={thread} /> : null}
    />
  )
}

// The line itself, for any header that states an agent's facts: the thread's (above) and a sub-agent
// drawer's (SubAgentSheet), so a child's header reads exactly as its thread's does.
export function HeaderFacts({
  lead,
  lastActiveAt,
  fallbackAt,
  reading,
  ...data
}: {
  lead?: ReactNode
  lastActiveAt: string | undefined
  fallbackAt?: string
  reading?: ReactNode
} & { [attribute: `data-${string}`]: boolean | string | undefined }) {
  return (
    <div {...data} className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-75 empty:hidden">
      {lead ? (
        <>
          {lead}
          <span aria-hidden className="shrink-0 text-muted-45">·</span>
        </>
      ) : null}
      <LastActive at={lastActiveAt} fallbackAt={fallbackAt} className="min-w-0 truncate" />
      {reading ? (
        <>
          {/* The separator shows only after a "Last active" that rendered — LastActive draws nothing for a
              thread with no timestamp at all, and a reading must never open on a dangling `·`. */}
          <span aria-hidden className="hidden shrink-0 text-muted-45 [time+&]:inline">·</span>
          {reading}
        </>
      ) : null}
    </div>
  )
}

/** The project a Console thread belongs to: its square and its name, from the machine's project list. */
function ThreadProject({ slug }: { slug: string }) {
  const projects = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList() })
  const project = projects.data?.find((p) => p.slug === slug)
  return (
    <span data-thread-project={slug} className="flex min-w-0 shrink-0 items-center gap-1.5 font-medium text-fg/80">
      {project ? <ProjectSquare project={project} size={14} /> : null}
      <span className="truncate">{project?.name ?? slug}</span>
    </span>
  )
}
