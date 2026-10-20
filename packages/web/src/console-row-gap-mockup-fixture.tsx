import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import type { ProjectCard, ThreadView } from "@frizz/shared"
import { ThreadRow } from "./components/Sidebar.tsx"
import { ProjectSquare } from "./components/ProjectRail.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

// MOCKUP SHEET — THE CONSOLE ROW'S PROJECT SQUARE, A HAIR CLOSER TO ITS STATUS SQUIRCLE.
//
// Not shipped UI and not a test. The maintainer, 2026-10-20, on All projects' "By status" rows: "I think
// the project icons and status squircles should be just a HAIR closer together. mock it up".
//
// TODAY the row button's `gap-2` spaces all three of its marks alike: project square → status box →
// title, 8px of box each. The square is a filled 16px tile, so its ink reaches its box edge; the status
// box is 15px centred in a 16px slot, so 0.5px of the slot is empty on each side. Ink gap today: 8.5px.
// Each option keeps the row's `gap-2` and trims the SQUARE's right margin only, so the squircle → title
// spacing does not move. The readings in each heading are measured on this page, not computed.
//
// Every row is the REAL ThreadRow with the Console's row square (ConsoleSidebar.tsx RowSquare), copied
// here because it is not exported; the option's trim is the one line that would change there.
//
//   nubx vite --port 5951 --strictPort   (from packages/web), then
//   http://localhost:5951/console-row-gap-mockup-fixture.html     (?theme=light for the light theme)
document.documentElement.dataset.font = "sans"
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark"

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  // location.href, not origin: the page also ships as one file:// document, whose origin is "null".
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.href)
  if (url.pathname.includes("/_frizz/")) return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  return originalFetch(input, init)
}

const project = (id: string, name: string) => ({ id, slug: id, name, path: `/fixture/${id}`, lastOpenedAt: "2026-10-20T00:00:00.000Z", stale: false, iconStatus: "none" }) as unknown as ProjectCard
const FRIZZ = project("frizz", "frizz")
const PULLFROG = project("pullfrog", "pullfrog")
const ZOD = project("zod", "zod")

const now = Date.now()
const ago = (min: number) => new Date(now - min * 60_000).toISOString()
const base = {
  kind: "session",
  backend: "claude",
  model: "opus",
  titleAuto: false,
  humanBlocked: false,
  pendingAsk: false,
  pendingQuestion: false,
  archived: false,
  foreign: false,
  state: "open",
  status: "active",
  crashed: false,
  subAgents: [],
  bgShells: [],
  dependsOn: [],
  spawnedAt: ago(300),
}
const thread = (id: string, title: string, over: Record<string, unknown>) => ({ ...base, id, title, ...over }) as unknown as ThreadView
const QUEUED = { runtime: "turn-idle", needsYou: true, lastAssistantAt: ago(14), lastActivityAt: ago(14) }

const ROWS: { project: ProjectCard; t: ThreadView; restedAge?: boolean }[] = [
  { project: FRIZZ, t: thread("q1", "Console pins for the By status view", { ...QUEUED, consolePinnedAt: ago(60) }) },
  { project: PULLFROG, t: thread("q2", "Rotate the preview client secret", { ...QUEUED, lastAssistantAt: ago(42) }), restedAge: true },
  { project: ZOD, t: thread("q3", "Triage the discriminated-union regression reported against 4.2, with a title long enough to wrap", { ...QUEUED, lastAssistantAt: ago(95) }), restedAge: true },
  { project: FRIZZ, t: thread("q4", "Audit the quota read path", { runtime: "exited", crashed: true, needsYou: true, lastAssistantAt: ago(130) }), restedAge: true },
  { project: PULLFROG, t: thread("r1", "Migrate the webhook verifier", { runtime: "running", lastActivityAt: ago(1) }) },
  { project: ZOD, t: thread("r2", "Draft the changelog", { runtime: "running", lastActivityAt: ago(2) }) },
]

const OPTIONS = [
  { key: "A", trim: 0, label: "Today", note: "gap-2 between all three marks" },
  { key: "B", trim: 1, label: "1px closer", note: "RowSquare -mr-px" },
  { key: "C", trim: 2, label: "2px closer", note: "RowSquare -mr-0.5", recommended: true },
  { key: "D", trim: 3, label: "3px closer", note: "RowSquare -mr-[3px]" },
  { key: "E", trim: 4, label: "4px closer", note: "RowSquare -mr-1" },
]

// Short titles for the magnified comparison, so each row is one line at 3×.
const SHORT: { project: ProjectCard; t: ThreadView; restedAge?: boolean }[] = [
  { project: PULLFROG, t: thread("s1", "Rotate secret", { ...QUEUED, lastAssistantAt: ago(42) }), restedAge: true },
  { project: ZOD, t: thread("s2", "Draft changelog", { runtime: "running", lastActivityAt: ago(2) }) },
]

/** Every option's rows stacked at 3×, each labelled, so a 1px step reads without a loupe. */
function Magnified() {
  return (
    <section className="mb-6 rounded-xl border border-border p-4">
      <header className="mb-1 text-[15px] font-semibold text-fg">All five at 3×</header>
      <p className="mb-3 text-[12px] text-muted-70">The squircle moves left; the title stays put relative to the squircle.</p>
      <div className="flex flex-col gap-3">
        {OPTIONS.map((option) => (
          <div key={option.key} className="flex items-center gap-4">
            <span className="w-24 shrink-0 text-[13px] text-muted-70">
              {option.key} · {option.label}
            </span>
            <div className="overflow-hidden" style={{ zoom: 3 }}>
              <div className="w-[300px]">
                <Column trim={option.trim} rows={SHORT} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/** ConsoleSidebar.tsx RowSquare, plus the option's trim on its right edge. */
function RowSquare({ project, trim }: { project: ProjectCard; trim: number }) {
  return (
    <span className="mt-[1.5px] shrink-0" title={project.name} style={trim ? { marginRight: -trim } : undefined}>
      <ProjectSquare project={project} size={16} />
    </span>
  )
}

/** The ink gaps on the first row of `root`: square's right edge → status box's left, and box → title. */
function useInkGaps(root: React.RefObject<HTMLDivElement | null>): string {
  const [text, setText] = useState("")
  useLayoutEffect(() => {
    const row = root.current?.querySelector<HTMLElement>("[data-sidebar-item] > button")
    if (!row) return
    const square = row.children[0]!.firstElementChild!.getBoundingClientRect()
    const slot = row.children[1] as HTMLElement
    // The status box: the widest element inside the 16px slot that is narrower than the slot itself.
    const box = [...slot.querySelectorAll<HTMLElement | SVGElement>("*")]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width >= 10 && r.width < 16)
      .sort((a, b) => b.width - a.width)[0]
    const title = row.children[2]!.querySelector("span")!
    const range = document.createRange()
    range.setStart(title.firstChild ?? title, 0)
    range.setEnd(title.firstChild ?? title, 1)
    const firstLetter = range.getBoundingClientRect()
    if (!box) return
    setText(`square → squircle ${(box.left - square.right).toFixed(1)}px · squircle → title ${(firstLetter.left - box.right).toFixed(1)}px`)
  }, [root])
  return text
}

function Column({ trim, rows, children }: { trim: number; rows: typeof ROWS; children?: ReactNode }) {
  return (
    <div className="flex flex-col">
      {children}
      {rows.map(({ project, t, restedAge }) => (
        <ThreadRow key={t.id} t={t} restedAge={restedAge} shelf="console" leading={<RowSquare project={project} trim={trim} />} />
      ))}
    </div>
  )
}

function Option({ option }: { option: (typeof OPTIONS)[number] }) {
  const ref = useRef<HTMLDivElement>(null)
  const gaps = useInkGaps(ref)
  return (
    <section ref={ref} className="min-w-0 rounded-xl border border-border p-4" data-option={option.key}>
      <header className="mb-3 flex items-baseline gap-2">
        <span className="text-[15px] font-semibold text-fg">
          {option.key} · {option.label}
        </span>
        {option.recommended && <span className="rounded border border-border px-1.5 text-[11px] text-muted-70">recommended</span>}
      </header>
      <div className="mb-3 text-[11.5px] leading-[16px] text-muted-70">
        <code>{option.note}</code>
        <br />
        {gaps}
      </div>
      {/* The Console column's own width band, so titles wrap where they would. */}
      <div className="w-[340px] max-w-full">
        <Column trim={option.trim} rows={ROWS.slice(0, 1)} />
        <hr className="my-3 border-border/50" />
        <Column trim={option.trim} rows={ROWS.slice(1, 4)} />
        <hr className="my-3 border-border/50" />
        <Column trim={option.trim} rows={ROWS.slice(4)} />
      </div>
    </section>
  )
}

function Sheet() {
  const light = document.documentElement.dataset.theme === "light"
  return (
    <div className="min-h-screen bg-bg px-8 py-8 text-fg">
      <div className="mb-6 flex items-baseline justify-between gap-6">
        <div>
          <h1 className="text-[20px] font-semibold">Console rows: project square → status squircle</h1>
          <p className="mt-1 max-w-[760px] text-[13px] leading-[19px] text-muted-70">
            Real rows from All projects' "By status" view. Each option trims only the project square's right margin, so the squircle → title spacing
            stays as it is. The readings under each heading are measured on this page.
          </p>
        </div>
        <a className="shrink-0 text-[13px] text-accent underline" href={`?theme=${light ? "dark" : "light"}`}>
          {light ? "Dark theme" : "Light theme"}
        </a>
      </div>
      <Magnified />
      <div className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))" }}>
        {OPTIONS.map((option) => (
          <Option key={option.key} option={option} />
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <Sheet />
    </TooltipProvider>
  </QueryClientProvider>,
)
