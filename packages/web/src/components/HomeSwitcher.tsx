import type { CSSProperties, MouseEvent } from "react"
import { Link, useLocation } from "react-router"
import { useQuery } from "@tanstack/react-query"
import { rpc } from "../api/rpc.ts"
import { useBoardLoaded, useQueuedThreads } from "../hooks.ts"
import { CONSOLE_PATH, isConsolePath } from "../lib/base-path.ts"
import { PROJECTS_HREF, type HomeView } from "../lib/homeView.ts"
import { RAIL_WIDTH_PX } from "./ProjectRail.tsx"

// THE SWITCH BETWEEN THE TWO HOMES — the project grid (`/`) and the Console (`/console`).
//
// FIXED to the top of the window, centred over the page beside the rail, so it stays where the operator
// left it however far the Console's cards scroll. It FLOATS: the pill is the whole of it, translucent
// and blurred, and the page scrolls on underneath it in plain sight (maintainer 2026-10-20: "supposed to
// be FLOATING. not be in a black top bar"). It stood on an opaque page-coloured band 62px tall until
// then, which cut every card off in a black strip across the top of the window. What must not slide
// under the pill keeps clear of it instead — the Console's card headers stick below it
// (lib/homeView.ts HOME_SWITCHER_CLEARANCE_PX, TodosView's sticky cap).
//
// The two tabs are one fixed width (HOME_TAB_PX), their words centred in them. Sized to its words the
// pill was 174px, and centred on the page its left edge landed within 4px of the Console cards' left edge
// in a 1440px window, which read as a misaligned attempt at lining up (maintainer 2026-10-20: "widen the
// Console/Projects switcher so it doesn't weirdly line up with the left edge of the queue cards"). The
// cards' edge sits a different distance left of the page's centre at every width — 121px at a 1280px
// window, 91px at 1440, 40px at 1728, and right of it past ~1900 — so no width avoids it everywhere; at
// 282px the pill's edge clears the cards' by 20px or more in every window from 1280px up, and in a
// narrower one it sits well inside them. A fixed width also stops the pill growing and shifting when the
// count gains a digit.
//
// The Console tab carries the queue's size across every project, drawn as the rail's badge FACE (the
// rail's badge is this face plus a 1px cut-out in the rail's colour; nothing sits under it here, so the
// cut-out goes). Both the word and the digits are trimmed to their cap band, so the tab's `items-center`
// centres ink on ink rather than line box on line box.

/** Each tab's width: two of them, the 2px between, 3px of padding and a 1px border a side make 282px. */
const HOME_TAB_PX = 136

/** The face's width per digit count — the rail's badgeWidth less its 1px cut-out each side. */
function faceWidth(count: number): number {
  return count < 10 ? 14 : count < 100 ? 20 : 26
}

const TRIM = { textBox: "trim-both cap alphabetic" } as CSSProperties

/**
 * Every project's queue, summed. On the Console it is counted off the merged board the sidebar is
 * drawing, so the tab and the Queue band beside it never disagree; on the grid it is the rail's poll.
 */
export function useQueueTotal(): number | undefined {
  const onConsole = isConsolePath()
  const board = useBoardLoaded()
  const queuedThreads = useQueuedThreads()
  const polled = useQuery({
    queryKey: ["projectsRailCounts"],
    queryFn: () => rpc.projectsRailCounts(),
    refetchInterval: 5_000,
  })
  if (onConsole && board) return queuedThreads.length
  if (!polled.data) return undefined
  return Object.values(polled.data).reduce((sum, counts) => sum + counts.queued, 0)
}

/** A click the router would take: the main button, no modifier. Anything else is the browser's (a new tab, a window). */
function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

export function HomeSwitcher({ railVisible }: { railVisible: boolean }) {
  // The tab that is lit is the page on screen. It read the KEPT home (lib/homeView.ts) until 2026-10-23,
  // which every tab shares: choosing Projects in one tab lit "Projects" over the Console in another.
  const view: HomeView = isConsolePath(useLocation().pathname) ? "console" : "projects"
  const total = useQueueTotal()
  // The page's own centre, not the window's: the rail takes the left 57px.
  const inset = railVisible ? RAIL_WIDTH_PX : 0
  const tab = (target: HomeView, label: string, count?: number) => {
    const selected = view === target
    // REAL LINKS, so hovering one shows its address and ⌘-click, middle-click and "Open link in new tab"
    // work. They were buttons until 2026-10-23. Neither tab needs to record the choice: each page records
    // it on arrival (routes.tsx ConsoleRoute, GridPage), and the Projects tab names the grid's own address
    // because `/` forwards to the Console while that is the kept home.
    return (
      <Link
        to={target === "console" ? CONSOLE_PATH : PROJECTS_HREF}
        role="tab"
        aria-selected={selected}
        data-home-tab={target}
        // The page you are on: a plain click stays put, as it did when the tabs were buttons, rather than
        // closing whatever thread the Console has open. A new tab still opens.
        onClick={(event) => { if (selected && isPlainClick(event)) event.preventDefault() }}
        className={`flex h-7 items-center justify-center whitespace-nowrap rounded-full px-3.5 text-[12.5px] leading-none outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${
          selected ? "bg-hover-strong text-fg shadow-[inset_0_0_0_1px_var(--hover-strong)]" : "text-muted hover:text-fg"
        }`}
        style={{ width: HOME_TAB_PX }}
      >
        <span className="block" style={TRIM}>{label}</span>
        {count ? (
          <span
            aria-label={`${count} in the queue`}
            data-home-queue-count={count}
            className="ml-1.5 flex h-[14px] shrink-0 items-center justify-center rounded-full bg-accent-fill text-[10px] font-semibold leading-none proportional-nums text-on-accent"
            style={{ width: faceWidth(count) }}
          >
            <span style={TRIM}>{count}</span>
          </span>
        ) : null}
      </Link>
    )
  }
  return (
    <div
      role="tablist"
      aria-label="Home"
      data-home-switcher
      className="fixed top-[14px] z-40 flex -translate-x-1/2 gap-0.5 rounded-full border border-border-strong bg-elevated/80 p-[3px] shadow-lg shadow-shadow-ink/40 backdrop-blur-md"
      style={{ left: `calc(${inset}px + (100% - ${inset}px) / 2)` }}
    >
      {tab("projects", "Projects")}
      {tab("console", "Console", total)}
    </div>
  )
}
