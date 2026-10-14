import type { CSSProperties } from "react"
import { useNavigate } from "react-router"
import { useQuery } from "@tanstack/react-query"
import { rpc } from "../api/rpc.ts"
import { useBoardLoaded, useQueuedThreads } from "../hooks.ts"
import { isConsolePath } from "../lib/base-path.ts"
import { HOME_BAND_PX, homeHref, setHomeView, useHomeView, type HomeView } from "../lib/homeView.ts"
import { RAIL_WIDTH_PX } from "./ProjectRail.tsx"

// THE SWITCH BETWEEN THE TWO HOMES — the project grid (`/`) and the Console (`/console`).
//
// FIXED to the top of the window, centred over the page beside the rail, with an opaque band behind it
// so the page scrolls UNDER it: the Console's cards are long and the switch must stay where the operator
// left it. The band fades out below its edge rather than ending on one (BAND_FADE_PX), because what
// scrolls under it is a column of cards, not a header.
//
// The Console tab carries the queue's size across every project, drawn as the rail's badge FACE (the
// rail's badge is this face plus a 1px cut-out in the rail's colour; nothing sits under it here, so the
// cut-out goes). Both the word and the digits are trimmed to their cap band, so the tab's `items-center`
// centres ink on ink rather than line box on line box, and the 14px face in a 28px tab sits 7px off its
// top and bottom — so it sits 7px off the tab's end too, and the two round ends share a centre.

/** The face's width per digit count — the rail's badgeWidth less its 1px cut-out each side. */
function faceWidth(count: number): number {
  return count < 10 ? 14 : count < 100 ? 20 : 26
}

const TRIM = { textBox: "trim-both cap alphabetic" } as CSSProperties

/**
 * The band is OPAQUE down to HOME_BAND_PX — the line the Console's card headers stick to — and fades out
 * over this much below it. Fading above that line let the card behind a stuck header show through in a
 * dimmed strip over it; below it, the fade lands on the header's own top padding, as a soft edge.
 */
const BAND_FADE_PX = 10

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

export function HomeSwitcher({ railVisible }: { railVisible: boolean }) {
  const view = useHomeView()
  const navigate = useNavigate()
  const total = useQueueTotal()
  // The page's own centre, not the window's: the rail takes the left 57px.
  const inset = railVisible ? RAIL_WIDTH_PX : 0
  const choose = (next: HomeView) => {
    // Recorded BEFORE the navigation: `/` forwards to the Console while that is the kept home.
    setHomeView(next)
    navigate(homeHref(next))
  }
  const tab = (target: HomeView, label: string, count?: number) => {
    const selected = view === target
    return (
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        data-home-tab={target}
        onClick={() => { if (!selected) choose(target) }}
        className={`flex h-7 items-center whitespace-nowrap rounded-full pl-3.5 text-[12.5px] leading-none outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${
          count ? "pr-[7px]" : "pr-3.5"
        } ${selected ? "bg-hover-strong text-fg shadow-[inset_0_0_0_1px_var(--hover-strong)]" : "text-muted hover:text-fg"}`}
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
      </button>
    )
  }
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed right-0 top-0 z-40"
        style={{
          left: inset,
          height: HOME_BAND_PX + BAND_FADE_PX,
          background: `linear-gradient(var(--color-bg) 0, var(--color-bg) ${HOME_BAND_PX}px, transparent)`,
        }}
      />
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
    </>
  )
}
