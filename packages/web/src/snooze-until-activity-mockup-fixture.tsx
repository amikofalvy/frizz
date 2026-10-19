import { createRoot } from "react-dom/client"
import type { ReactNode } from "react"
import {
  Activity,
  AlarmClock,
  AlarmClockOff,
  Bot,
  Check,
  CircleAlert,
  GitPullRequestArrow,
  Hourglass,
  Maximize2,
  Pin,
  TerminalSquare,
} from "lucide-react"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { ON_CAP, WaitRow } from "./components/AwaitingBackgroundCard.tsx"
import {
  CARD_ACTION_EXPLAINER,
  CARD_BODY,
  CARD_PRIMARY_ACTION,
  CardActions,
  TranscriptCard,
} from "./components/TranscriptCard.tsx"
import { STATUS_BOX } from "./components/BoxSpinner.tsx"
import { HEADER_ICON_CLASS } from "./lib/headerIcon.ts"
import { OPAQUE_SURFACE_BASE } from "./lib/overlaySurface.ts"
import { formatSnoozeWake, SNOOZE_PRESETS, snoozePresetInstant } from "./lib/snooze.ts"
import "./styles.css"

// MOCKUP SHEET — "SNOOZE UNTIL ACTIVITY" AS AN OPTION OF THE HEADER'S SNOOZE MENU.
//
// Not shipped UI and not a test. The maintainer, 2026-10-19: "We should support a snooze till activity
// option. mock it up", then: "There should probably be some kind of alert or notification if they do
// this on a thread that has no possible awaker."
//
// WHAT IS TRUE TODAY (read from the code on 2026-10-19):
//   · The header's alarm clock (SnoozeMenu) offers clock times only: 1h, tomorrow, 1d, 3d, 1w, custom.
//   · "Until activity" already exists, but only as the resting card's own Snooze button
//     (AwaitingBackgroundCard, rpc.snoozeAwaitingBackground), captioned "Hides card until new activity is
//     detected". It records the current rest instant, and the card comes back when the thread next comes
//     to rest. The board honours it only while the thread has its own work out (a shell, a sub-agent, a
//     watched PR, a parked timer) — a bare rest cannot be snoozed that way at all.
//
// The sheet proposes the same verb in the header menu, for every thread, and what it says when nothing
// on the thread could ever end it. Every card, row and menu is drawn with the app's own classes; the
// transcript cards are the real TranscriptCard and WaitRow. Nothing is sent anywhere.
//
//   nubx vite --port 5441 --strictPort   (from packages/web), then
//   http://localhost:5441/snooze-until-activity-mockup-fixture.html
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = "sans"
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark"

// ---- what can wake a thread ----------------------------------------------------------------------
// The things frizz itself delivers a wake for — the same list `frizzctl activity` prints. A steer from
// another thread can also wake it, but nothing can know one is coming, so it never counts as an awaker.
type Awaker = { kind: "pr" | "shell" | "agent" | "timer"; name: string; status: string }
const BUSY: Awaker[] = [
  { kind: "pr", name: "acme/app#391", status: "CI running" },
  { kind: "shell", name: "nub run test", status: "12m" },
]
const KIND_WORD: Record<Awaker["kind"], string> = { pr: "PR", shell: "shell", agent: "sub-agent", timer: "timer" }
function wakeSummary(awakers: Awaker[]): string {
  const words = [...new Set(awakers.map((a) => KIND_WORD[a.kind]))]
  if (words.length <= 1) return words[0] ?? ""
  return `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`
}

// ---- menu pieces (static, drawn open) ------------------------------------------------------------
const MENU_ITEM = "flex select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] outline-none"
function Item({ icon, hot, dim, children }: { icon?: ReactNode; hot?: boolean; dim?: boolean; children: ReactNode }) {
  return (
    <div className={`${MENU_ITEM} ${hot ? "bg-panel-2 text-fg" : "text-muted"} ${dim ? "opacity-45" : ""}`}>
      {icon && <span className="flex w-3.5 shrink-0 items-center justify-center self-start pt-[3px]">{icon}</span>}
      {children}
    </div>
  )
}
const Sep = () => <div className="my-1 h-px bg-border" />
function Row({ label, detail, detailClass = "text-muted-55" }: { label: ReactNode; detail?: ReactNode; detailClass?: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-center justify-between gap-6">
      <span>{label}</span>
      {detail && <span className={`text-[10.5px] ${detailClass}`}>{detail}</span>}
    </span>
  )
}
function TimedRows() {
  return (
    <>
      {SNOOZE_PRESETS.map((p) => {
        const wake = formatSnoozeWake(snoozePresetInstant(p.value))
        const row = p.value === "tomorrow" ? { label: "Tomorrow", wake: wake.replace(/^Tomorrow at /, "") } : { label: p.label, wake }
        return (
          <Item key={p.value} icon={<AlarmClock size={12} />}>
            <Row label={row.label} detail={row.wake} />
          </Item>
        )
      })}
    </>
  )
}
const Heading = ({ children }: { children: ReactNode }) => <div className="px-2.5 pb-1 pt-1.5 text-[11px] text-muted-60">{children}</div>
const Custom = () => <Item>Custom time &amp; prompt…</Item>
const ACTIVITY_ICON = <Activity size={12} />

function MenuPanel({ children }: { children: ReactNode }) {
  return <div className={`${OPAQUE_SURFACE_BASE} w-max min-w-[184px] max-w-[300px] rounded-lg p-1`}>{children}</div>
}

// The thread header's action strip, with the menu dropped from the alarm clock as it opens in the app:
// right edge under the clock's right edge (Radix `align="end"`), 6px below it. In the page's flow
// rather than absolutely placed, so a frame grows to hold it instead of the menu covering what follows.
// 60px = the two 28px squares right of the clock plus their two 2px gaps.
function HeaderWithMenu({ armed, children, tip }: { armed?: boolean; children?: ReactNode; tip?: string }) {
  const clock = armed ? HEADER_ICON_CLASS.replace(/(^| )text-muted( |$)/, "$1text-attention-90$2") : HEADER_ICON_CLASS
  return (
    <div className="flex flex-col items-end">
      <div className="flex items-center gap-0.5">
        <span className={HEADER_ICON_CLASS}><Pin size={14} strokeWidth={2} /></span>
        <span className="relative flex">
          <span className={`${clock} ${children ? "bg-panel-2" : ""}`}><AlarmClock size={14} strokeWidth={2} /></span>
          {tip && <TipBubble label={tip} />}
        </span>
        <span className={HEADER_ICON_CLASS}><Check size={14} strokeWidth={2} /></span>
        <span className={HEADER_ICON_CLASS}><Maximize2 size={14} strokeWidth={2} /></span>
      </div>
      {children && <div className="mr-[60px] mt-1.5">{children}</div>}
    </div>
  )
}

function TipBubble({ label }: { label: string }) {
  return (
    <span className="pointer-events-none absolute bottom-full right-[-4px] z-40 mb-[5px] whitespace-pre rounded-md border border-border bg-elevated px-3 py-2 text-[11px] leading-relaxed text-fg shadow-md shadow-shadow-ink/40">
      {label}
      <svg width="10" height="5" viewBox="0 0 10 5" aria-hidden className="absolute right-[13px] top-full fill-elevated"><polygon points="0,0 10,0 5,5" /></svg>
    </span>
  )
}

// ---- other app chrome, drawn ---------------------------------------------------------------------
function Toast({ children, actions = [], warn }: { children: ReactNode; actions?: string[]; warn?: boolean }) {
  return (
    <div className="flex max-w-[30rem] items-center gap-2.5 break-words rounded-lg border border-border-strong bg-elevated px-4 py-2 text-[13px] font-medium text-fg shadow-xl shadow-shadow-ink/40">
      {warn && <CircleAlert size={14} className="shrink-0 text-attention" />}
      <span className="min-w-0">{children}</span>
      {actions.map((a) => (
        <span key={a} className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[12px] text-fg/90">{a}</span>
      ))}
    </div>
  )
}

const BTN_OUTLINE = "button-outline rounded-md px-3 py-1.5 text-[12px] text-muted"
const BTN_SOLID = "button-outline rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg"
function DialogDrawn({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex w-[380px] flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl shadow-shadow-ink/50">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-[13px] font-medium">{title}</header>
      <div className="flex flex-col gap-2.5 p-4 text-[13px] leading-5 text-fg/75">{children}</div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">{footer}</footer>
    </div>
  )
}

function StatusBoxDrawn({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-[4px] border border-muted/45" style={{ width: STATUS_BOX, height: STATUS_BOX }}>
      {children}
    </span>
  )
}
// The tooltip the mark opens on hover, drawn open BESIDE the row rather than over it, so the titles stay
// readable in the frame.
function RailRow({ mark, title, tip }: { mark: ReactNode; title: string; tip?: string }) {
  return (
    <div className="relative flex h-[26px] items-center gap-2 rounded-md px-1.5 text-[12.5px] text-fg/55">
      {mark}
      <span className="truncate">{title}</span>
      {tip && (
        <span className="pointer-events-none absolute left-full top-1/2 z-40 ml-4 -translate-y-1/2 whitespace-pre rounded-md border border-border bg-elevated px-3 py-2 text-[11px] leading-relaxed text-fg shadow-md shadow-shadow-ink/40">
          {tip}
        </span>
      )}
    </div>
  )
}

// ---- the transcript's snooze card, until-activity shape -----------------------------------------
function AwakerRow({ a }: { a: Awaker }) {
  const mark = a.kind === "pr"
    ? <GitPullRequestArrow size={12} className={`${ON_CAP} text-muted-70`} />
    : a.kind === "shell"
      ? <TerminalSquare size={12} className={`${ON_CAP} text-shell`} />
      : a.kind === "agent"
        ? <Bot size={12} className={`${ON_CAP} text-muted-60`} />
        : <Hourglass size={12} className={`${ON_CAP} text-muted-60`} />
  return <WaitRow testKind={a.kind === "pr" ? "github" : a.kind === "timer" ? "timer" : a.kind} testId={a.name} mark={mark} name={a.name} status={a.status} onOpen={() => {}} />
}
function ActivitySnoozeCard({ awakers }: { awakers: Awaker[] }) {
  const none = awakers.length === 0
  return (
    <TranscriptCard icon={AlarmClock} label="Snoozed" tone={none ? "caution" : "neutral"}>
      <div className="text-[22px] font-semibold leading-8 tracking-tight text-fg">Until activity</div>
      {none ? (
        <p className={CARD_BODY}>
          Nothing on this thread can wake it — no shell, sub-agent, watch, timer or goal is out. It comes back
          when you message it or another thread steers it.
        </p>
      ) : (
        <>
          <p className={CARD_BODY}>Returns to the queue the next time it rests — when one of these reports back.</p>
          <div className="-mx-2 mt-3 flex flex-col gap-y-px">
            {awakers.map((a) => <AwakerRow key={a.name} a={a} />)}
          </div>
        </>
      )}
      <CardActions>
        <span className={CARD_PRIMARY_ACTION}>Wake now</span>
        {none && <span className={`${CARD_PRIMARY_ACTION} !bg-transparent !text-fg/80 border border-border`}>Snooze 1w instead</span>}
      </CardActions>
    </TranscriptCard>
  )
}

// ---- sheet layout --------------------------------------------------------------------------------
function Section({ n, title, children, intro }: { n: number; title: string; intro: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-14">
      <h2 className="text-[17px] font-semibold text-fg">{n}. {title}</h2>
      <div className="mt-1.5 max-w-[760px] text-[13px] leading-5 text-muted">{intro}</div>
      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">{children}</div>
    </section>
  )
}
function Frame({ letter, title, note, pick, wide, children, stage = "min-h-[340px]" }: {
  letter: string
  title: string
  note: ReactNode
  pick?: boolean
  wide?: boolean
  stage?: string
  children: ReactNode
}) {
  return (
    <div className={`flex flex-col rounded-xl border ${pick ? "border-accent/50" : "border-border"} bg-panel ${wide ? "xl:col-span-2" : ""}`}>
      <div className="flex items-baseline gap-2 border-b border-border px-4 py-3">
        <span className="text-[13px] font-semibold text-fg">{letter}</span>
        <span className="text-[13px] font-medium text-fg">{title}</span>
        {pick && <span className="ml-auto rounded-md border border-accent/50 px-1.5 py-px text-[10.5px] font-medium text-accent">Recommended</span>}
      </div>
      <p className="px-4 pt-3 text-[12px] leading-[18px] text-muted">{note}</p>
      <div className={`m-4 mt-3 flex-1 rounded-lg border border-border/60 bg-bg p-4 ${stage}`}>{children}</div>
    </div>
  )
}
const Arrow = ({ children }: { children: ReactNode }) => (
  <div className="flex items-center gap-2 py-2 text-[11px] text-muted-60">
    <span className="h-px w-6 bg-border" />
    {children}
  </div>
)

// ---- the sheet -----------------------------------------------------------------------------------
function Sheet() {
  const busy = wakeSummary(BUSY)
  return (
    <div className="mx-auto max-w-[1180px] px-8 pb-24 pt-10">
      <h1 className="text-[22px] font-semibold tracking-tight text-fg">Snooze until activity</h1>
      <div className="mt-2 max-w-[760px] text-[13px] leading-5 text-muted">
        <p>
          A snooze with no clock: the thread leaves the queue and comes back the next time it rests on its own —
          a shell ends, a sub-agent returns, a watched PR or issue moves, its timer or goal fires, or another thread
          steers it. While it works it shows in Active as usual, and its next rest puts it back in the queue.
        </p>
        <p className="mt-2">
          It already exists as the resting card's Snooze button, but only for a thread with background work out.
          These frames add it to the header's alarm-clock menu for every thread. The example thread is resting on
          a watched PR (<code className="text-fg/80">acme/app#391</code>) and a running shell, unless a frame says otherwise.
        </p>
      </div>

      <Section
        n={1}
        title="Where it sits in the snooze menu"
        intro={<>The clock rows say when the thread comes back on the right; the activity row says <em>what</em> brings it back in the same place.</>}
      >
        <Frame letter="A" pick title="First row, what wakes it on the right" note={<>Its own group above the clock times. The right column names the kinds of thing that can wake it (“{busy}”); hovering the row lists them by name.</>}>
          <HeaderWithMenu>
            <MenuPanel>
              <Heading>Snooze</Heading>
              <Item icon={ACTIVITY_ICON} hot><Row label="Until activity" detail={busy} /></Item>
              <Sep />
              <TimedRows />
              <Sep />
              <Custom />
            </MenuPanel>
          </HeaderWithMenu>
        </Frame>

        <Frame letter="B" title="First row, the things themselves on a second line" note="Names each awaker in the menu itself, so nothing needs a hover. Costs a taller first row, and long names get cut.">
          <HeaderWithMenu>
            <MenuPanel>
              <Heading>Snooze</Heading>
              <Item icon={ACTIVITY_ICON} hot>
                <span className="flex min-w-0 flex-col">
                  <span>Until activity</span>
                  <span className="truncate text-[10.5px] text-muted-55">acme/app#391 or <span className="font-mono">nub run test</span></span>
                </span>
              </Item>
              <Sep />
              <TimedRows />
              <Sep />
              <Custom />
            </MenuPanel>
          </HeaderWithMenu>
        </Frame>

        <Frame letter="C" title="After the clock times" note="Keeps today's menu as it is and adds the row at the end, above Custom. Quieter, but it is the one option that is not a time, filed among the times.">
          <HeaderWithMenu>
            <MenuPanel>
              <Heading>Snooze</Heading>
              <TimedRows />
              <Item icon={ACTIVITY_ICON} hot><Row label="Until activity" detail={busy} /></Item>
              <Sep />
              <Custom />
            </MenuPanel>
          </HeaderWithMenu>
        </Frame>

        <Frame letter="Also" title="The resting card's own Snooze, renamed to match" note={<>Whichever menu wins, the resting card's button does the same thing, so it takes the same name and loses its caption (today: “Snooze” beside “Hides card until new activity is detected”).</>} stage="min-h-0">
          <div className="flex flex-col gap-3">
            <div className="text-[11px] text-muted-60">Today</div>
            <div className="max-w-[420px] rounded-xl border border-border-strong bg-panel-2 px-4 pb-0 pt-0">
              <CardActions className="!mx-[-16px] !mb-0 !mt-0 rounded-xl border-t-0">
                <span className={CARD_PRIMARY_ACTION}><Hourglass size={12} />Snooze</span>
                <span className={CARD_ACTION_EXPLAINER}>Hides card until new activity is detected</span>
              </CardActions>
            </div>
            <div className="text-[11px] text-muted-60">Proposed</div>
            <div className="max-w-[420px] rounded-xl border border-border-strong bg-panel-2 px-4">
              <CardActions className="!mx-[-16px] !mb-0 !mt-0 rounded-xl border-t-0">
                <span className={CARD_PRIMARY_ACTION}><Activity size={12} />Snooze until activity</span>
              </CardActions>
            </div>
          </div>
        </Frame>
      </Section>

      <Section
        n={2}
        title="When nothing can wake the thread"
        intro={<>
          The thread rests with nothing out: no shell, sub-agent, watch, timer or goal. Snoozed until activity, it would
          stay out of the queue until someone messages it. Frizz can tell this is the case when the menu opens, so it
          can say so before the click, after it, or both.
        </>}
      >
        <Frame letter="A" pick title="Warn in the row, confirm on click" note="The row turns amber and says why before it is picked. Picking it anyway opens a confirmation offering a clock time instead." stage="min-h-0">
          <div className="flex flex-col gap-2">
            <div>
              <HeaderWithMenu>
                <MenuPanel>
                  <Heading>Snooze</Heading>
                  <Item icon={<Activity size={12} className="text-attention" />} hot>
                    <Row label="Until activity" detail="Nothing can wake it" detailClass="text-attention" />
                  </Item>
                  <Sep />
                  <TimedRows />
                  <Sep />
                  <Custom />
                </MenuPanel>
              </HeaderWithMenu>
            </div>
            <div className="flex flex-col">
              <Arrow>after the click</Arrow>
              <DialogDrawn
                title="Nothing can wake this thread"
                footer={<>
                  <span className={BTN_OUTLINE}>Cancel</span>
                  <span className={BTN_OUTLINE}>Snooze 1w instead</span>
                  <span className={BTN_SOLID}>Snooze anyway</span>
                </>}
              >
                <p>It has nothing running and nothing armed: no shell, sub-agent, watched PR or issue, timer or goal.</p>
                <p>Snoozed until activity, it stays out of the queue until you message it or another thread steers it.</p>
              </DialogDrawn>
            </div>
          </div>
        </Frame>

        <Frame letter="B" title="Warn in the row, fall back to a clock" note="No dialog. The row says up front that it will come back in a week if nothing happens, and the toast repeats the date." stage="min-h-0">
          <div className="flex flex-col gap-2">
            <div>
              <HeaderWithMenu>
                <MenuPanel>
                  <Heading>Snooze</Heading>
                  <Item icon={<Activity size={12} className="text-attention" />} hot>
                    <span className="flex min-w-0 flex-col">
                      <span>Until activity</span>
                      <span className="text-[10.5px] text-attention">Nothing can wake it · back in 1w</span>
                    </span>
                  </Item>
                  <Sep />
                  <TimedRows />
                  <Sep />
                  <Custom />
                </MenuPanel>
              </HeaderWithMenu>
            </div>
            <div className="flex flex-col">
              <Arrow>after the click</Arrow>
              <Toast warn>Nothing can wake this thread, so it comes back {formatSnoozeWake(snoozePresetInstant("1w")).replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase())}</Toast>
            </div>
          </div>
        </Frame>

        <Frame letter="C" title="Not offered" note="The row is disabled and says why. Nothing to warn about afterwards, because it cannot happen. The strictest, and it rules out parking a thread for a steer you know is coming.">
          <div>
            <HeaderWithMenu>
              <MenuPanel>
                <Heading>Snooze</Heading>
                <Item icon={ACTIVITY_ICON} dim><Row label="Until activity" detail="Nothing can wake it" /></Item>
                <Sep />
                <TimedRows />
                <Sep />
                <Custom />
              </MenuPanel>
            </HeaderWithMenu>
          </div>
        </Frame>

        <Frame letter="D" title="Snooze, then warn" note="The row looks like any other; the click goes through, and an amber toast says what just happened with a way back. Least friction, easiest to miss.">
          <div className="flex flex-col gap-2">
            <div>
              <HeaderWithMenu>
                <MenuPanel>
                  <Heading>Snooze</Heading>
                  <Item icon={ACTIVITY_ICON} hot><Row label="Until activity" /></Item>
                  <Sep />
                  <TimedRows />
                  <Sep />
                  <Custom />
                </MenuPanel>
              </HeaderWithMenu>
            </div>
            <div className="flex flex-col">
              <Arrow>after the click</Arrow>
              <Toast warn actions={["Undo", "Make it 1w"]}>Snoozed, but nothing can wake this thread</Toast>
            </div>
          </div>
        </Frame>

        <Frame letter="+" wide title="And if the last awaker goes away mid-snooze" note={<>
          A thread snoozed while its shell ran can lose every awaker without resting again — the worker process
          dies, or a watch is withdrawn. Nothing would ever end that snooze, so it ends itself: the thread goes back
          to the queue and says why. Pairs with any of A–D.
        </>} stage="min-h-0">
          <div className="flex flex-wrap items-start gap-8">
            <div className="w-[420px]">
              <TranscriptCard icon={AlarmClockOff} label="Snooze ended" tone="caution">
                <p className={CARD_BODY}>
                  Nothing on this thread can wake it any more: the worker exited while it was snoozed until activity,
                  so it is back in the queue.
                </p>
              </TranscriptCard>
            </div>
            <div className="flex flex-col">
              <div className="pb-2 text-[11px] text-muted-60">and, if the board is open</div>
              <Toast warn actions={["Open"]}>“Fix the resolver cache” is back — nothing left to wake it</Toast>
            </div>
          </div>
        </Frame>
      </Section>

      <Section n={3} title="While it is snoozed" intro="The same three places a clock snooze shows today: the header's amber alarm clock, the card at the end of the transcript, and the Snoozed band on the rail.">
        <Frame letter="A" title="The transcript card" note="The countdown's place says “Until activity”, and the rows it is waiting on sit under it — the same rows the resting card draws." stage="min-h-0">
          <div className="max-w-[440px]"><ActivitySnoozeCard awakers={BUSY} /></div>
        </Frame>
        <Frame letter="B" title="The transcript card, nothing can wake it" note="What a thread shows after “Snooze anyway” (2A), or a warning toast left alone (2D). The card stays amber for as long as nothing can wake it, and offers the clock time once more." stage="min-h-0">
          <div className="max-w-[440px]"><ActivitySnoozeCard awakers={[]} /></div>
        </Frame>
        <Frame letter="C" title="The header, reopened" note="The clock stays amber, its tooltip says what it is waiting on, and the menu leads with Wake now as it does for a clock snooze." stage="min-h-[330px] pt-16">
          <HeaderWithMenu armed tip={"Snoozed until activity\nacme/app#391 or nub run test"} />
          <div className="mt-6">
            <HeaderWithMenu armed>
              <MenuPanel>
                <Heading>Snoozed until activity</Heading>
                <Item icon={<AlarmClockOff size={12} />} hot>Wake now</Item>
                <Sep />
                <TimedRows />
                <Sep />
                <Custom />
              </MenuPanel>
            </HeaderWithMenu>
          </div>
        </Frame>
        <Frame letter="D" title="The rail's Snoozed band" note="Each row wears the mark of what will wake it, as an event-snoozed row does today; one with nothing to wake it wears the alarm clock in amber." stage="min-h-0">
          <div className="w-[260px]">
            <div className="flex w-full items-center gap-1 px-1.5 py-1 text-[11px] uppercase leading-4 tracking-wide text-muted-70">
              <span className="w-[11px] shrink-0" aria-hidden />Snoozed<span className="ml-1.5 tabular-nums text-muted-60">4</span>
            </div>
            <RailRow
              mark={<StatusBoxDrawn><GitPullRequestArrow size={9} className="text-muted-70" /></StatusBoxDrawn>}
              title="Fix the resolver cache"
              tip={"Snoozed until activity\nacme/app#391 or nub run test"}
            />
            <RailRow mark={<StatusBoxDrawn><span aria-hidden className="frizz-rail-dot" /></StatusBoxDrawn>} title="Audit the auth flow" />
            <RailRow mark={<StatusBoxDrawn><GitPullRequestArrow size={9} className="text-muted-70" /></StatusBoxDrawn>} title="Land the dependabot bumps" />
            <RailRow
              mark={<StatusBoxDrawn><AlarmClock size={9} className="text-attention" /></StatusBoxDrawn>}
              title="Draft the 0.16 release notes"
              tip={"Snoozed until activity\nNothing can wake it"}
            />
          </div>
        </Frame>
      </Section>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Sheet />
  </TooltipProvider>,
)
