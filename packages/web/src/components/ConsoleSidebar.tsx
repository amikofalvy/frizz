import { useCallback, useMemo, useRef, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { ChevronDown, ChevronUp } from "lucide-react"
import type { ProjectCard, ThreadView } from "@frizz/shared"
import { store } from "../store.ts"
import { useBoardThreads } from "../hooks.ts"
import { isConsolePinned, pinnedOn, type PinShelf } from "../groups.ts"
import { prefs } from "../lib/prefs.ts"
import { useOptimisticallySteered } from "../lib/steering.ts"
import { useOptimisticallyArchived } from "../lib/optimisticArchive.ts"
import { useConsoleProjectList } from "../lib/consoleProjects.ts"
import {
  RUNNING_CAP,
  consoleCardOrder,
  consolePinPlacements,
  consolePinned,
  consoleQueue,
  consoleRunning,
  projectBlocks,
  setConsoleGroup,
  setRunningExpanded,
  useConsoleGroup,
  useRunningExpanded,
  type ConsoleGroup,
} from "../lib/consoleBoard.ts"
import { bareSlug, keyProject, threadKey } from "../lib/threadKey.ts"
import { rpcFor } from "../api/rpc.ts"
import { unlandedDispatches, useConsolePendingDispatches, type PendingDispatchEntry } from "../lib/pendingDispatch.ts"
import { ProjectScope } from "../lib/projectScope.tsx"
import { STACKED_RAIL_ANCHOR_CLASS, stackedRailAnchor } from "../lib/stackedRailAnchor.ts"
import { CONSOLE_TOP_PX } from "../lib/homeView.ts"
import { DispatchForm } from "./NewThreadModal.tsx"
import { useConsoleDispatchTarget } from "./ConsoleProjectChip.tsx"
import { ProjectSquare } from "./ProjectRail.tsx"
import { PinnedBand, SectionHeader, StartingRow, SubAgentRows, ThreadRow, useQueueScrollspy } from "./Sidebar.tsx"
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
//   · "By status" keeps a pin shelf of its own, apart from every project board's (lib/consoleBoard.ts
//     PINS): a Pinned band above Queue, drawn and dragged like a board's;
//   · it is anchored under the home switcher rather than centred in the window, because the switcher is
//     fixed at the window's top and a centred column would slide under it on a short window.

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
  // Untracked, like the project rail's (hooks.ts useBoardThreads): this board is EVERY project's.
  const all = useOptimisticallyArchived(useOptimisticallySteered(useBoardThreads()))
  const direction = useSnapshot(prefs).queueOrder
  const group = useConsoleGroup()
  const { projects, bySlug } = useConsoleProjectList()
  const order = useMemo(() => projects.map((project) => project.slug), [projects])
  const waiting = consoleCardOrder(consoleQueue(all, direction), group, order)
  const running = consoleRunning(all)
  // "By status" lifts the Console's own pins out of Queue and Running into the Pinned band above them.
  // The card order already leads with the pinned rows' cards (consoleCardOrder), so `waiting` stays the
  // scroll marker's order whole.
  const pinned = useMemo(() => (group === "status" ? consolePinned(all) : []), [group, all])
  const queueRows = group === "status" ? waiting.filter((t) => !isConsolePinned(t)) : waiting
  const runningRows = group === "status" ? running.filter((t) => !isConsolePinned(t)) : running
  const reorderPins = useConsolePinReorder(pinned)
  // A dispatch from the prompt box above, drawn as the Running row it is about to become — the project
  // sidebar's own treatment (Sidebar.tsx StartingRow). With the "Starting thread…" card that stood under
  // this box instead, every row moved down 93px at the click and back up when the call answered, and the
  // thread's own row landed under the card in between (recorded 2026-10-13, three runs per grouping).
  // The board's ids are only gathered while one is pending.
  const pending = useConsolePendingDispatches()
  const starting = useMemo(() => (pending.length === 0 ? pending : unlandedDispatches(pending, new Set(all.map((t) => t.id)))), [pending, all])
  const runningCount = runningRows.length + starting.length
  const { railRef, activeId, navigateToQueueCard } = useQueueScrollspy(snap.view, snap.drawers.length, waiting.map((t) => t.id))

  const square = (t: ThreadView) => <RowSquare project={bySlug.get(keyProject(t.id) ?? "")} />
  // By status the rows speak for the Console's shelf; by project, for each project board's own.
  const shelf: PinShelf = group === "status" ? "console" : "board"
  const row = (t: ThreadView, opts: { square: boolean; waiting: boolean }) => (
    <div key={t.id}>
      <ThreadRow
        t={t}
        // Waiting rows only: a running row has no queue card, and the marker a just-sent row arrives
        // with is handed to the row that took its place (markerRow in lib/sidebarScrollspy).
        active={opts.waiting && activeId === t.id}
        onQueueNavigate={navigateToQueueCard}
        // A pinned row wears its pin in the rest-time column instead (ThreadRow), as on a project's board.
        restedAge={opts.waiting && !pinnedOn(t, shelf)}
        leading={opts.square ? square(t) : undefined}
        shelf={shelf}
      />
      <SubAgentRows t={t} />
    </div>
  )
  const startingRow = (entry: PendingDispatchEntry, opts: { square: boolean }) => (
    <StartingRow key={`starting-${entry.key}`} entry={entry} leading={opts.square ? <RowSquare project={bySlug.get(entry.project ?? "")} /> : undefined} />
  )

  return (
    <aside ref={stackedRailAnchor} className={`${CONSOLE_SIDEBAR_COLUMN_CLASS} ${STACKED_RAIL_ANCHOR_CLASS}`} style={{ paddingTop: CONSOLE_TOP_PX }} data-console-sidebar>
      <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col max-[800px]:max-h-none">
        {/* mb-5: the 20px that sets the grouping switch off from the prompt box (GroupSwitch). */}
        <div className="mb-5 shrink-0 px-0.5">
          <StatusRow label="All projects" />
          <ConsoleDispatch />
        </div>
        <GroupSwitch group={group} />
        {/* The rows scroll BEHIND the switch, as a project's do behind its prompt box (Sidebar.tsx): the
            12px under the switch is the list's own top padding, so its scroll edge is the switch's bottom
            edge rather than a strip of page colour below it. */}
        <div ref={railRef} data-sidebar-rail className="-mt-3 min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-10 pt-3 max-[800px]:overflow-y-visible">
          {pinned.length === 0 && queueRows.length === 0 && runningCount === 0 ? (
            <div className="py-1 pl-5 pr-1.5 text-[11.5px] text-muted-50">Nothing waiting or running</div>
          ) : group === "status" ? (
            <>
              {/* PINNED — the Console's own shelf, the project board's band in every respect but whose it
                  is: out of Queue and Running whatever its rows' state, ordered by the pins, dragged to
                  rearrange. Its waiting rows' cards lead the cards, so the marker reaches them first. */}
              {pinned.length > 0 && (
                <section aria-label="Pinned" data-console-pinned>
                  <SectionHeader label="Pinned" count={pinned.length} />
                  <PinnedBand
                    threads={pinned}
                    railRef={railRef}
                    activeId={activeId}
                    onQueueNavigate={navigateToQueueCard}
                    shelf="console"
                    leading={square}
                    onReorder={reorderPins}
                  />
                  {queueRows.length + runningCount > 0 && <hr className="my-3 border-border/50" />}
                </section>
              )}
              {queueRows.length > 0 && <SectionHeader label="Queue" count={queueRows.length} />}
              {queueRows.map((t) => row(t, { square: true, waiting: true }))}
              {runningCount > 0 && queueRows.length > 0 && <hr className="my-3 border-border/50" />}
              {runningCount > 0 && <SectionHeader label="Running" count={runningCount} />}
              {/* Newest first, the band's own order: a thread that starts lands at the top. */}
              {[...starting].reverse().map((entry) => startingRow(entry, { square: true }))}
              {runningRows.map((t) => row(t, { square: true, waiting: false }))}
            </>
          ) : (
            projectBlocks(waiting, running, order, starting).map((block, i) => (
              <section key={block.project} aria-label={bySlug.get(block.project)?.name ?? block.project} data-console-project={block.project}>
                {i > 0 && <hr className="my-3 border-border/50" />}
                <ProjectHeader project={bySlug.get(block.project)} slug={block.project} />
                {block.waiting.map((t) => row(t, { square: false, waiting: true }))}
                <RunningRows
                  project={block.project}
                  rows={block.running}
                  starting={block.starting}
                  render={(t) => row(t, { square: false, waiting: false })}
                  renderStarting={(entry) => startingRow(entry, { square: false })}
                />
              </section>
            ))
          )}
        </div>
      </div>
    </aside>
  )
}

/**
 * How a drag in the Console's Pinned band is written. The band spans projects, so the browser works out
 * the new instants (lib/consoleBoard.ts consolePinPlacements) — usually one row's — and sends each project
 * its own share. Instants it has sent and the board has not shown yet stand in for the board's, so a
 * second drag made before the first lands is placed against the order on screen, not the one before it.
 */
function useConsolePinReorder(pinned: readonly ThreadView[]): (ids: readonly string[]) => Promise<unknown> {
  const pinnedRef = useRef(pinned)
  pinnedRef.current = pinned
  const sent = useRef(new Map<string, string>())
  return useCallback((ids: readonly string[]) => {
    for (const [id, at] of sent.current) {
      const t = pinnedRef.current.find((x) => x.id === id)
      if (!t || t.consolePinnedAt === at) sent.current.delete(id)
    }
    const shelf = pinnedRef.current
      .map((t) => (sent.current.has(t.id) ? { ...t, consolePinnedAt: sent.current.get(t.id) } : t))
      .sort((a, b) => (a.consolePinnedAt ?? "").localeCompare(b.consolePinnedAt ?? "") || a.id.localeCompare(b.id))
    const writes = consolePinPlacements(shelf, ids)
    const byProject = new Map<string, { slug: string; at: string }[]>()
    for (const write of writes) {
      const project = keyProject(write.id)
      if (!project) continue
      sent.current.set(write.id, write.at)
      let pins = byProject.get(project)
      if (!pins) byProject.set(project, (pins = []))
      pins.push({ slug: bareSlug(write.id), at: write.at })
    }
    const calls = [...byProject].map(([project, pins]) =>
      rpcFor(project).reorderConsolePinnedThreads({ pins }).catch((error: unknown) => {
        for (const pin of pins) sent.current.delete(threadKey(project, pin.slug))
        throw error
      }),
    )
    return Promise.all(calls)
  }, [])
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
function RunningRows({
  project,
  rows,
  starting,
  render,
  renderStarting,
}: {
  project: string
  rows: ThreadView[]
  starting: PendingDispatchEntry[]
  render: (t: ThreadView) => ReactNode
  renderStarting: (entry: PendingDispatchEntry) => ReactNode
}) {
  const expanded = useRunningExpanded(project)
  // A thread that is starting is one of the running rows already, for the cap as for the eye: it takes
  // the top place its own row will land in (newest first), so the cap cuts the same rows before the row
  // lands as after.
  const total = starting.length + rows.length
  const capped = total > RUNNING_CAP
  const room = capped && !expanded ? RUNNING_CAP : total
  const shownStarting = [...starting].reverse().slice(0, room)
  const shown = rows.slice(0, room - shownStarting.length)
  return (
    <>
      {shownStarting.map(renderStarting)}
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
 * "By status" | "By project": a segmented control as wide as the prompt box, the chosen half raised.
 *
 * It was two borderless words until 2026-10-13, and that read as the prompt box's footer rather than the
 * list's header: 12px of muted text 12px under the box, and lighter than the project names it groups. Of
 * seven mockups the maintainer chose this one ("I do think it's got to be full width. Option C: segmented
 * control"). Full width, it spans the list it sorts; the top block's `mb-5` is the 20px that separates it
 * from the box. The idiom is the GitHub picker's `Segmented` (GithubPickerModal.tsx), stretched to the
 * column: a bordered track, the chosen segment lifted to `elevated`. The track's 10px corner less its 4px
 * inset (border + `p-[3px]`) is the segments' 6px (`rounded-md`), so the two arcs share a centre.
 */
function GroupSwitch({ group }: { group: ConsoleGroup }) {
  const option = (value: ConsoleGroup, label: string) => (
    <button
      type="button"
      aria-pressed={group === value}
      data-console-group={value}
      onClick={() => setConsoleGroup(value)}
      className={`h-[26px] min-w-0 flex-1 truncate rounded-md px-2 text-[12.5px] font-medium leading-none outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${
        group === value ? "bg-elevated text-fg shadow-sm shadow-shadow-ink/30" : "text-muted-70 hover:text-fg"
      }`}
    >
      {label}
    </button>
  )
  return (
    <div
      role="group"
      aria-label="Group the list"
      className="mx-0.5 mb-3 flex shrink-0 gap-[3px] rounded-[10px] border border-border bg-fg/[0.03] p-[3px]"
      data-console-group-switch
    >
      {option("status", "By status")}
      {option("project", "By project")}
    </div>
  )
}

/** The prompt box, pointed at the project its chip names (components/ConsoleProjectChip.tsx). */
function ConsoleDispatch() {
  const { project, chip } = useConsoleDispatchTarget()
  return (
    <ProjectScope project={project?.slug}>
      {/* No "Starting thread…" card under this box: the rail draws the pending thread itself (above). */}
      <DispatchForm projectPicker={chip} pendingCard={false} />
    </ProjectScope>
  )
}
