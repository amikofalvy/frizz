import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { ThreadRow } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// The rail row's PIN verb. Order and fill ARE the contract (maintainer 2026-09-03): a row that can be
// pinned offers an OUTLINE pin LEFT of the fullscreen door; a PINNED row offers the solid slashed unpin
// RIGHTMOST in the hover strip — after Retry too. At rest a pinned row shows no pin at all: the Pinned
// band's label says it, and the right edge carries the row's rest time (2026-10-24). And the strip draws
// no box of its own: its backing is the rail's base colour under the row's hover wash, never the old
// `bg-panel` pill.

const base = {
  kind: "session",
  backend: "claude",
  title: "A thread",
  status: "active",
  runtime: "turn-idle",
  subAgents: [],
} as unknown as ThreadView

// Retry (on the stalled rows) is an eager send and wants the app's query client; the harness supplies
// it exactly as Sidebar.retry.test.ts does.
function row(extra: Partial<ThreadView>, props: { shelf?: "board" | "console" } = {}) {
  const t = { ...base, id: "thread", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadRow, { t, ...props })),
    ),
  )
}

const PINNED = { pinnedAt: "2026-09-02T10:00:00.000Z" } as Partial<ThreadView>
const STALLED = { runtime: "exited", crashed: true, needsYou: true } as Partial<ThreadView>

/** The hover strip's class list — the element the retry test also finds by its `absolute right-1.5`. */
function stripClasses(html: string): string {
  const at = html.indexOf('class="absolute right-1.5')
  assert.notEqual(at, -1, "the row renders its hover strip")
  const start = at + 'class="'.length
  return html.slice(start, html.indexOf('"', start))
}

/** The pin button's icon markup: from the button's data attribute to the end of its svg. */
function pinIcon(html: string): string {
  const at = html.indexOf("data-sidebar-pin=")
  assert.notEqual(at, -1, "the row offers the pin verb")
  return html.slice(at, html.indexOf("</svg>", at))
}

test("a row that can be pinned offers an OUTLINE pin, left of the fullscreen door", () => {
  const html = row({})
  const icon = pinIcon(html)
  assert.match(icon, /aria-label="Pin thread"/)
  assert.match(icon, /fill="none"/, "the pin is drawn as an outline: a filled pin means pinned")
  assert.doesNotMatch(icon, /fill="currentColor"/)
  assert.ok(html.indexOf("data-sidebar-pin=") < html.indexOf("data-expand-thread="), "the pin precedes the door")
})

test("a pinned row wears no pin at rest and offers the solid unpin RIGHTMOST, after the door", () => {
  const html = row(PINNED)
  // The only pin on the row is the hover strip's button; the right-edge column belongs to the rest time.
  assert.equal(html.split("lucide-pin").length - 1, 1, "one pin glyph, and it is the unpin in the strip")
  const icon = pinIcon(html)
  assert.match(icon, /aria-label="Unpin thread"/)
  assert.match(icon, /fill="currentColor"/, "the unpin is solid: a filled pin means pinned")
  const pinAt = html.indexOf("data-sidebar-pin=")
  assert.ok(pinAt > html.indexOf("data-expand-thread="), "the unpin follows the door")
  // Nothing renders after the unpin inside the strip: its button is the strip's last child.
  const rest = html.slice(html.indexOf("</button>", pinAt) + "</button>".length)
  assert.ok(rest.startsWith("</div>"), `the unpin is the strip's last action, got: ${rest.slice(0, 40)}`)
})

test("on a pinned row that also offers Retry, the unpin still sits past Retry, at the far right", () => {
  const html = row({ ...PINNED, ...STALLED })
  const doorAt = html.indexOf("data-expand-thread=")
  const retryAt = html.indexOf("data-sidebar-retry=")
  const pinAt = html.indexOf("data-sidebar-pin=")
  assert.ok(doorAt !== -1 && retryAt !== -1 && pinAt !== -1, "door, Retry and unpin all render")
  assert.ok(doorAt < retryAt && retryAt < pinAt, "door → Retry → unpin, left to right")
})

test("on an unpinned row that offers Retry, the pin keeps its place left of the door", () => {
  const html = row(STALLED)
  assert.ok(html.indexOf("data-sidebar-pin=") < html.indexOf("data-expand-thread="), "pin → door")
  assert.ok(html.indexOf("data-expand-thread=") < html.indexOf("data-sidebar-retry="), "door → Retry")
})

test("the strip draws no box: its backing is the rail's base colour, and the row's wash paints above it", () => {
  const html = row(PINNED)
  const strip = stripClasses(html)
  assert.doesNotMatch(strip, /\bbg-panel\b/, "the old opaque pill is gone")
  assert.doesNotMatch(strip, /\brounded\b/, "…and so is its rounding")
  assert.match(strip, /\bbg-bg\b/, "the backing is the rail's base colour, so the title cannot bleed through")
  assert.match(strip, /\bbefore:.*from-transparent\b/, "with a fade off its left edge so a covered letter dissolves")
  // The row's hover wash sits ABOVE the strip (an `after:` pseudo), which is what makes the backing
  // invisible — a `hover:bg-*` under the strip would show the backing as a box again.
  const rowAt = html.indexOf('data-sidebar-item="thread"')
  const rowClasses = html.slice(rowAt, html.indexOf(">", rowAt))
  assert.match(rowClasses, /hover:after:opacity-100/, "the wash is the row's after: pseudo, revealed on hover")
  assert.doesNotMatch(rowClasses, /hover:bg-/, "no background wash under the strip")
})

test("a foreign (read-only) row offers no pin verb in either position", () => {
  const html = row({ foreign: true })
  assert.doesNotMatch(html, /data-sidebar-pin=/)
  assert.match(html, /data-expand-thread=/, "the door is still there")
})

// THE CONSOLE'S "BY STATUS" SHELF is a second pin, and a row shows exactly one of the two: there, its
// verb reads and writes the Console's pin, and its project board's pin is not offered at all.
test("on the Console's shelf a row speaks for the Console's pin alone", () => {
  const CONSOLE = { consolePinnedAt: "2026-10-19T10:00:00.000Z" } as Partial<ThreadView>
  const consolePinned = row(CONSOLE, { shelf: "console" })
  assert.match(pinIcon(consolePinned), /aria-label="Unpin thread from All projects"/)
  assert.match(pinIcon(consolePinned), /data-pin-shelf="console"/)

  const boardPinned = row(PINNED, { shelf: "console" })
  assert.match(pinIcon(boardPinned), /aria-label="Pin thread to All projects"/)

  // And the board's rows never read the Console's pin.
  assert.match(pinIcon(row(CONSOLE)), /aria-label="Pin thread"/)
})
