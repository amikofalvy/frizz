import * as RadixDropdown from "@radix-ui/react-dropdown-menu"
import { useCallback, useMemo, useState, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { Check, ChevronDown, ChevronUp } from "lucide-react"
import type { ProjectCard, ThreadView } from "@frizz/shared"
import { store } from "../store.ts"
import { asThreads, useBoard } from "../hooks.ts"
import { isPinned } from "../groups.ts"
import { prefs } from "../lib/prefs.ts"
import { useOptimisticallySteered } from "../lib/steering.ts"
import { useOptimisticallyArchived } from "../lib/optimisticArchive.ts"
import { useConsoleProjectList } from "../lib/consoleProjects.ts"
import {
  RUNNING_CAP,
  consoleCardOrder,
  consoleQueue,
  consoleRunning,
  projectBlocks,
  setConsoleGroup,
  setRunningExpanded,
  useConsoleGroup,
  useRunningExpanded,
  type ConsoleGroup,
} from "../lib/consoleBoard.ts"
import { keyProject } from "../lib/threadKey.ts"
import { ProjectScope } from "../lib/projectScope.tsx"
import { OPAQUE_SURFACE_BASE } from "../lib/overlaySurface.ts"
import { HOME_BAND_PX } from "../lib/homeView.ts"
import { DispatchForm } from "./NewThreadModal.tsx"
import { ProjectSquare } from "./ProjectRail.tsx"
import { SectionHeader, SubAgentRows, ThreadRow, useQueueScrollspy } from "./Sidebar.tsx"
import { StatusRow } from "./StatusRow.tsx"

// THE CONSOLE'S SIDEBAR — a project board's sidebar, drawn from every open project at once.
//
// The same column as a project's (Sidebar.tsx): the status row and the prompt box at its top, the rows
// under them, the scroll marker opposite the card being read. What differs is what it holds, and where
// it sits:
//   · the status row names "All projects", and the prompt box carries a PROJECT chip saying where a new
//     task goes;
//   · two bands only — Queue and Running — because the Console is for what needs the operator now.
//     Snoozed and Done stay on each project's own board (maintainer 2026-10-11: "I don't think those
//     are worth including");
//   · a switch between the two groupings, "By status" and "By project", with no label: the two words say
//     what they do (maintainer 2026-10-11);
//   · it is anchored under the home switcher's band rather than centred in the window, because the band
//     is fixed chrome at the window's top and a centred column would slide under it on a short window.

export const CONSOLE_SIDEBAR_COLUMN_CLASS =
  "sticky top-0 self-start h-screen w-[clamp(272px,34vw,680px)] shrink-0 flex flex-col pb-4 max-[800px]:static max-[800px]:h-auto max-[800px]:w-full max-[800px]:pt-16"

/** A 16px project square beside a 19px title line: the half-step that centres it on the line. */
function RowSquare({ project }: { project: ProjectCard | undefined }) {
  if (!project) return <span aria-hidden className="h-4 w-4 shrink-0" />
  return (
    <span className="mt-[1.5px] shrink-0" title={project.name}>
      <ProjectSquare project={project} size={16} />
    </span>
  )
}

export function ConsoleSidebar() {
  const snap = useSnapshot(store)
  const board = useBoard()
  const all = useOptimisticallyArchived(useOptimisticallySteered(asThreads(board?.threads ?? [])))
  const direction = useSnapshot(prefs).queueOrder
  const group = useConsoleGroup()
  const { projects, bySlug } = useConsoleProjectList()
  const order = useMemo(() => projects.map((project) => project.slug), [projects])
  const waiting = consoleCardOrder(consoleQueue(all, direction), group, order)
  const running = consoleRunning(all)
  const { railRef, activeId, navigateToQueueCard } = useQueueScrollspy(snap.view, snap.drawers.length)

  const row = (t: ThreadView, opts: { square: boolean; waiting: boolean }) => (
    <div key={t.id}>
      <ThreadRow
        t={t}
        active={activeId === t.id}
        onQueueNavigate={navigateToQueueCard}
        // A pinned row wears its pin in the rest-time column instead (ThreadRow), as on a project's board.
        restedAge={opts.waiting && !isPinned(t)}
        leading={opts.square ? <RowSquare project={bySlug.get(keyProject(t.id) ?? "")} /> : undefined}
      />
      <SubAgentRows t={t} />
    </div>
  )

  return (
    <aside className={CONSOLE_SIDEBAR_COLUMN_CLASS} style={{ paddingTop: HOME_BAND_PX + 8 }} data-console-sidebar>
      <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col max-[800px]:max-h-none">
        <div className="mb-3 shrink-0 px-0.5">
          <StatusRow label="All projects" />
          <ConsoleDispatch projects={projects} />
        </div>
        <GroupSwitch group={group} />
        <div ref={railRef} data-sidebar-rail className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-10 max-[800px]:overflow-y-visible">
          {waiting.length === 0 && running.length === 0 ? (
            <div className="py-1 pl-5 pr-1.5 text-[11.5px] text-muted-50">Nothing waiting or running</div>
          ) : group === "status" ? (
            <>
              {waiting.length > 0 && <SectionHeader label="Queue" count={waiting.length} />}
              {waiting.map((t) => row(t, { square: true, waiting: true }))}
              {running.length > 0 && waiting.length > 0 && <hr className="my-3 border-border/50" />}
              {running.length > 0 && <SectionHeader label="Running" count={running.length} />}
              {running.map((t) => row(t, { square: true, waiting: false }))}
            </>
          ) : (
            projectBlocks(waiting, running, order).map((block, i) => (
              <section key={block.project} aria-label={bySlug.get(block.project)?.name ?? block.project} data-console-project={block.project}>
                {i > 0 && <hr className="my-3 border-border/50" />}
                <ProjectHeader project={bySlug.get(block.project)} slug={block.project} />
                {block.waiting.map((t) => row(t, { square: false, waiting: true }))}
                <RunningRows project={block.project} rows={block.running} render={(t) => row(t, { square: false, waiting: false })} />
              </section>
            ))
          )}
        </div>
      </div>
    </aside>
  )
}

/**
 * A project's block header: its square where the rows' indicators sit, then its name. No count — the
 * rows under it are the count (maintainer 2026-10-11: "I don't think the numerical count to the right of
 * each project name is doing very much").
 */
function ProjectHeader({ project, slug }: { project: ProjectCard | undefined; slug: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2 pb-[3px] pl-5 pr-1.5 pt-1" data-console-project-header>
      {project ? (
        <span className="mt-[1.5px] shrink-0">
          <ProjectSquare project={project} size={16} />
        </span>
      ) : null}
      <span className="min-w-0 truncate text-[12.5px] font-semibold leading-[19px] text-fg/85">{project?.name ?? slug}</span>
    </div>
  )
}

/**
 * A project's running rows, the first RUNNING_CAP of them until the operator asks for the rest. A long
 * run of spinners is the least actionable thing in the column — nothing in it is waiting on anyone — so
 * it must not push the next project's queue off the screen (maintainer 2026-10-11: "cut it off at however
 * many you think is appropriate, with a Show more button"). Three keeps a busy project's block about
 * as tall as a queue of three.
 */
function RunningRows({ project, rows, render }: { project: string; rows: ThreadView[]; render: (t: ThreadView) => ReactNode }) {
  const expanded = useRunningExpanded(project)
  const capped = rows.length > RUNNING_CAP
  const shown = capped && !expanded ? rows.slice(0, RUNNING_CAP) : rows
  return (
    <>
      {shown.map(render)}
      {capped ? (
        <button
          type="button"
          data-console-show-more={project}
          aria-expanded={expanded}
          onClick={() => setRunningExpanded(project, !expanded)}
          className="flex w-full items-center gap-2 rounded-md pb-1 pl-5 pr-1.5 pt-1 text-left text-[12px] leading-[19px] text-muted-70 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
        >
          {/* In the indicator column, so the words start where the titles above them do. */}
          <span className="flex h-[19px] w-4 shrink-0 items-center justify-center">
            {expanded ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
          </span>
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  )
}

/**
 * "By status" | "By project". Borderless — it is a view setting under the prompt box, not a control
 * competing with it — and left-aligned to the rows' titles' inset so it reads as the list's own.
 */
function GroupSwitch({ group }: { group: ConsoleGroup }) {
  const option = (value: ConsoleGroup, label: string) => (
    <button
      type="button"
      aria-pressed={group === value}
      data-console-group={value}
      onClick={() => setConsoleGroup(value)}
      className={`h-[22px] rounded-md px-2 text-[12px] leading-none outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${
        group === value ? "bg-elevated text-fg" : "text-muted-70 hover:text-fg"
      }`}
    >
      {label}
    </button>
  )
  return (
    <div role="group" aria-label="Group the list" className="mb-2 flex shrink-0 gap-0.5 pl-3" data-console-group-switch>
      {option("status", "By status")}
      {option("project", "By project")}
    </div>
  )
}

const PICK_KEY = "frizz:console-dispatch-project"

function readPick(): string | null {
  try {
    return localStorage.getItem(PICK_KEY)
  } catch {
    return null
  }
}

/** The prompt box, pointed at the project its chip names. */
function ConsoleDispatch({ projects }: { projects: ProjectCard[] }) {
  const [picked, setPicked] = useState<string | null>(readPick)
  // The remembered project while it is still open here, else the first in the rail's order.
  const project = projects.find((p) => p.slug === picked) ?? projects[0]
  const pick = useCallback((slug: string) => {
    setPicked(slug)
    try {
      localStorage.setItem(PICK_KEY, slug)
    } catch {
      // Not remembered, but it holds for this page.
    }
  }, [])
  // Memoized: the form's footer is memoized on it, and a fresh element per keystroke would rebuild it.
  const chip = useMemo(
    () => (project ? <ProjectChip project={project} projects={projects} onPick={pick} /> : null),
    [project, projects, pick],
  )
  return (
    <ProjectScope project={project?.slug}>
      <DispatchForm projectPicker={chip} />
    </ProjectScope>
  )
}

/**
 * The prompt box's PROJECT chip: where a task typed here will run. Shaped like the profile pill beside
 * it (ProfileGridSelector's trigger) so the two read as one strip of settings for the next thread.
 */
function ProjectChip({ project, projects, onPick }: { project: ProjectCard; projects: ProjectCard[]; onPick: (slug: string) => void }) {
  return (
    <RadixDropdown.Root modal={false}>
      <RadixDropdown.Trigger asChild>
        <button
          type="button"
          aria-label={`Project: ${project.name}`}
          title="The project a new thread runs in"
          data-console-project-chip={project.slug}
          className="group inline-flex min-w-0 max-w-[min(14rem,40vw)] cursor-pointer items-center gap-1.5 rounded-md border border-border/50 bg-transparent py-1 pl-1 pr-2 text-left text-[12px] leading-4 text-fg/90 outline-none transition-colors hover:border-border hover:bg-panel-2 data-[state=open]:border-border data-[state=open]:bg-panel-2"
        >
          <ProjectSquare project={project} size={16} />
          <span className="min-w-0 truncate">{project.name}</span>
          <ChevronDown aria-hidden size={13} className="shrink-0 text-fg/65 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </RadixDropdown.Trigger>
      <RadixDropdown.Portal>
        <RadixDropdown.Content
          align="start"
          side="bottom"
          sideOffset={5}
          collisionPadding={8}
          className={`z-[110] ${OPAQUE_SURFACE_BASE} max-h-[min(360px,var(--radix-dropdown-menu-content-available-height))] min-w-[200px] overflow-auto rounded-lg p-1.5`}
        >
          {projects.map((p) => (
            <RadixDropdown.Item
              key={p.id}
              onSelect={() => onPick(p.slug)}
              data-console-project-option={p.slug}
              className="flex cursor-default items-center gap-2 rounded px-1.5 py-1 text-[12.5px] text-fg outline-none data-[highlighted]:bg-panel-2"
            >
              <ProjectSquare project={p} size={16} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <Check aria-hidden size={13} className={p.slug === project.slug ? "shrink-0 text-fg/70" : "invisible shrink-0"} />
            </RadixDropdown.Item>
          ))}
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  )
}
