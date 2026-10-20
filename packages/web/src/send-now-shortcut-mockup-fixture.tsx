import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { ArrowUp } from "lucide-react"
import type { ChatMessage } from "./hooks.ts"
import { Message, WorkingIndicator } from "./components/ChatView.tsx"
import { Composer } from "./components/Composer.tsx"
import { HUMAN_RUN_STEP, STEP, VSpace } from "./components/rhythm.tsx"
import { Tooltip, TooltipProvider } from "./components/Tooltip.tsx"
import { sendPlaceholder, type SendMode } from "./lib/sendMode.ts"
import "./styles.css"

// MOCKUP SHEET — ⌘⏎ PRESSES "SEND NOW", AND THE CONTROL SAYS SO.
//
// Not shipped UI and not a test. The maintainer, 2026-10-19: "'Send Now' should also be triggerable with
// Command+Enter. That applies even if the focus is currently in the prompt box and you have nothing
// written. It should also probably show that as a shortcut. Mock it up."
//
// WHAT IS TRUE TODAY (read from the code on 2026-10-19):
//   · Send now is one quiet "↑ Send now" link under the queued messages (ChatView QueuedSendNow). A run
//     sent to the queue goes to the agent's next step on the first press; a run waiting for the agent's
//     next step is pushed through on the next (router deliverQueuedNow). It has no shortcut.
//   · ⌘/Ctrl-Enter in the prompt box is the FORCED send of the words typed there (interrupt and send,
//     Composer onInterruptSubmit). With the box empty it does nothing: the composer's `canSend` gate
//     refuses it. Outside the box it does nothing either.
//
// THE BEHAVIOUR EVERY CANDIDATE SHARES: with nothing typed, ⌘⏎ presses Send now — with the caret in the
// empty box or with focus anywhere else in the thread — and does exactly what a click would at that
// moment. With words typed it keeps today's meaning and sends them now. Only the way the control shows
// the chord differs between candidates.
//
// The transcript is the REAL Message and WorkingIndicator, and the prompt box is the REAL Composer with
// its Send split button: its own Enter and ⌘⏎-with-words run unchanged, and the frame catches the empty
// ⌘⏎ the composer lets through. The Send now line is drawn here. Nothing is sent anywhere.
//
//   nubx vite --port 5462 --strictPort   (from packages/web), then
//   http://localhost:5462/send-now-shortcut-mockup-fixture.html   (?theme=light)
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = "sans"
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark"

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  // location.href, not origin: the page also ships as one file:// document, whose origin is "null".
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.href)
  if (url.pathname.includes("/_frizz/")) return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  return originalFetch(input, init)
}

// Ctrl is ⌘'s twin off a Mac throughout the app, so the label follows the platform.
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const CHORD = MAC ? "⌘⏎" : "Ctrl ⏎"

const MIN = 60_000
const at = (min: number) => new Date(Date.now() - min * MIN).toISOString()

const AGENT: ChatMessage = {
  sourceId: "a1",
  role: "assistant",
  text: "Reproducing the spacing on the queue card now — I'll measure both surfaces before changing anything.",
  tools: [],
  parts: [{ kind: "text", text: "Reproducing the spacing on the queue card now — I'll measure both surfaces before changing anything." }],
  at: at(3),
} as ChatMessage

const WORDS = ["also check the drawer", "and the full page — the card can wait until the other two are right"]

type Run = "steer" | "held"
interface Tail {
  /** The words still waiting, and how they wait. Null once nothing does. */
  run: Run | null
  queued: string[]
  /** Words the agent has been handed, drawn after its message and before its next step. */
  read: string[]
}
const start = (run: Run): Tail => ({ run, queued: WORDS, read: [] })

function bubble(text: string, i: number, queued: boolean): ChatMessage {
  return { sourceId: `${queued ? "q" : "r"}${i}-${text.length}`, role: "user", text, tools: [], parts: [], ...(queued ? { queued: true } : {}) } as ChatMessage
}

// ── the Send now line ────────────────────────────────────────────────────────────────────────────────

interface LineProps {
  run: Run
  onSend: () => void
  /** ⌘⏎ just pressed it: the control lifts to full tone for a beat, as a hover would. */
  pressed: boolean
  /** The caret is in the prompt box and the box is empty — the moment the chord is in the hand. */
  boxReady: boolean
}

const TITLE: Record<Run, string> = {
  held: "Send them now — the agent reads them at its next step",
  steer: "Send now — the worker reads the queue immediately, and a command it is running carries on in the background",
}

// The shipped control's own glyph: a 1em arrow on the words' baseline, lifted to the middle of their
// cap band, so it sits on the words in any face at any size (ChatView QueuedSendNow).
const glyph = "size-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]"
const line = "flex items-baseline justify-end text-[11.5px] leading-[16px] text-muted"

function SendNowButton({ run, onSend, pressed, title = true, children }: Omit<LineProps, "boxReady"> & { title?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSend}
      title={title ? `${TITLE[run]} (${CHORD})` : undefined}
      className={`flex items-baseline gap-1 outline-none transition-colors duration-150 hover:text-fg focus-visible:text-fg ${pressed ? "text-fg" : ""}`}
    >
      {children}
    </button>
  )
}

const Arrow = () => <ArrowUp aria-hidden className={glyph} strokeWidth={2.4} />
const Words = () => <span className="underline decoration-border underline-offset-2">Send now</span>
// The chord as plain type, a step quieter than the words — a menu row's shortcut, not a second link.
const Chord = ({ className = "" }: { className?: string }) => <span aria-hidden className={`no-underline text-muted-60 ${className}`}>{CHORD}</span>

type Candidate = {
  key: string
  name: string
  says: string
  line: (props: LineProps) => ReactNode
  /** E puts the chord in the empty box instead. */
  /** What the box says, given what it says today. */
  placeholder?: (run: Run, today: string) => string
}

const CANDIDATES: Candidate[] = [
  {
    key: "A",
    name: "The chord after the words, as plain type",
    says: `↑ Send now ${CHORD}. The chord sits in the line's own type, the way a menu row carries its shortcut, and stays put when the words lift on hover. In dark it is a step dimmer than the words; light's muted greys are one grey, so there it matches them.`,
    line: ({ run, onSend, pressed }) => (
      <div className={line}>
        <SendNowButton run={run} onSend={onSend} pressed={pressed}>
          <Arrow />
          <Words />
        </SendNowButton>
        <Chord className="ml-1.5" />
      </div>
    ),
  },
  {
    key: "B",
    name: "The chord on a keycap",
    says: "The same place, drawn as the keycap prose draws a <kbd>: panel fill, a strong hairline with a heavier bottom lip. Reads as a key at a glance, at the cost of a box in a line that is otherwise only type.",
    line: ({ run, onSend, pressed }) => (
      <div className={line}>
        <SendNowButton run={run} onSend={onSend} pressed={pressed}>
          <Arrow />
          <Words />
        </SendNowButton>
        <span aria-hidden className="md-inline ml-1.5"><kbd>{CHORD}</kbd></span>
      </div>
    ),
  },
  {
    key: "C",
    name: "The chord in place of the arrow",
    says: `${CHORD} Send now. The chord is the control's glyph, so the line stays two marks wide and the shortcut is the first thing read.`,
    line: ({ run, onSend, pressed }) => (
      <div className={line}>
        <SendNowButton run={run} onSend={onSend} pressed={pressed}>
          <span aria-hidden className="no-underline">{CHORD}</span>
          <Words />
        </SendNowButton>
      </div>
    ),
  },
  {
    key: "D",
    name: "Only while the empty box has the caret",
    says: "Today's ↑ Send now, unchanged at rest. Put the caret in the prompt box with nothing typed and the chord fades in to its left — the moment it is in the hand. Nothing moves when it does.",
    line: ({ run, onSend, pressed, boxReady }) => (
      <div className={line}>
        <SendNowButton run={run} onSend={onSend} pressed={pressed}>
          <span aria-hidden className="relative flex items-baseline">
            <span className={`absolute right-full mr-2 whitespace-nowrap text-muted-60 transition-opacity duration-150 ${boxReady ? "opacity-100" : "opacity-0"}`}>{CHORD}</span>
            <Arrow />
          </span>
          <Words />
        </SendNowButton>
      </div>
    ),
  },
  {
    key: "E",
    name: "In the empty prompt box",
    says: "The line under the queue is today's. The empty box says it instead, in its placeholder — shown exactly while the chord means Send now, and gone the moment a word is typed and the chord means something else. It doubles the placeholder's length: in a box set to queue it wraps to a second line at a drawer's width.",
    line: ({ run, onSend, pressed }) => (
      <div className={line}>
        <SendNowButton run={run} onSend={onSend} pressed={pressed}>
          <Arrow />
          <Words />
        </SendNowButton>
      </div>
    ),
    placeholder: (_run, today) => `${today} or ${CHORD} to send the queue now`,
  },
  {
    key: "F",
    name: "In the tooltip only",
    says: `Nothing new on screen: hovering Send now opens the app's tooltip, "Send now ${CHORD}". The quietest, and the one nobody finds by looking.`,
    line: ({ run, onSend, pressed }) => (
      <div className={line}>
        {/* The tooltip's trigger merges its pointer handlers into its child, so the child is a plain
            element rather than a component that would drop them. */}
        <Tooltip label={`Send now ${CHORD}`}>
          <span className="flex items-baseline">
            <SendNowButton run={run} onSend={onSend} pressed={pressed} title={false}>
              <Arrow />
              <Words />
            </SendNowButton>
          </span>
        </Tooltip>
      </div>
    ),
  },
]

// ── one frame: a drawer's transcript tail and its prompt box ─────────────────────────────────────────

const link = "underline decoration-border underline-offset-2 outline-none transition-colors hover:text-fg focus-visible:text-fg"

function isChord(e: KeyboardEvent): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing
}

function CandidateFrame({ candidate, initial }: { candidate: Candidate; initial: Run }) {
  const [tail, setTail] = useState<Tail>(() => start(initial))
  const [draft, setDraft] = useState("")
  const [mode, setMode] = useState<SendMode>(initial === "held" ? "queue" : "steer")
  const [pressed, setPressed] = useState(false)
  const [boxFocused, setBoxFocused] = useState(false)
  const [said, setSaid] = useState("")
  const timer = useRef<number | undefined>(undefined)

  // What one press of Send now does: a held run goes to the agent's next step, and a run waiting for
  // that step is pushed through.
  const advance = () =>
    setTail((t) => (t.run === "held" ? { ...t, run: "steer" } : { run: null, queued: [], read: [...t.read, ...t.queued] }))
  const outcome = (run: Run | null) => (run === "held" ? "sent them to the agent's next step" : "pushed them through now")

  const click = () => {
    setSaid(`Clicked Send now — ${outcome(tail.run)}.`)
    advance()
  }
  // The chord lifts the control for a beat first, so the frame shows WHICH control the key pressed
  // before the line changes or goes.
  const chord = () => {
    if (!tail.run) return
    setSaid(`${CHORD} with the box empty pressed Send now — ${outcome(tail.run)}.`)
    setPressed(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      setPressed(false)
      advance()
    }, 220)
  }

  // The composer handles ⌘⏎ itself whenever there is something to send, and stops it there. With the
  // box empty it lets the chord through, and this — the thread's surface — takes it.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!isChord(e) || draft.trim()) return
    e.preventDefault()
    chord()
  }

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    setDraft("")
    setSaid(mode === "queue" ? "Enter sent it to the queue." : "Enter sent it as a steer; it waits for the agent's next step.")
    setTail((t) => ({ ...t, run: t.run ?? (mode === "queue" ? "held" : "steer"), queued: [...t.queued, text] }))
  }
  const forced = () => {
    const text = draft.trim()
    if (!text) return
    setDraft("")
    setSaid(`${CHORD} with words typed sent them now, as today — the queue went in ahead of them.`)
    setTail((t) => ({ run: null, queued: [], read: [...t.read, ...t.queued, text] }))
  }

  const reset = () => {
    setTail(start(initial))
    setDraft("")
    setSaid("")
  }

  const Line = candidate.line
  const today = sendPlaceholder({ staged: 0, openQuestions: false, running: true, mode })
  const placeholder = tail.run && candidate.placeholder ? candidate.placeholder(tail.run, today) : today
  const changed = said !== "" || draft !== ""
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-60">{initial === "steer" ? "Sent as steer" : "Sent to queue"}</div>
      <div data-mock-frame tabIndex={-1} onKeyDown={onKeyDown} className="flex flex-col overflow-hidden rounded-xl border border-border bg-bg outline-none">
        <div className="flex flex-col px-6 pb-4 pt-5">
          <Message m={AGENT} />
          {tail.read.map((text, i) => (
            <div key={`r${i}`} className="flex flex-col">
              <VSpace h={i === 0 ? STEP : HUMAN_RUN_STEP} />
              <Message m={bubble(text, i, false)} />
            </div>
          ))}
          <VSpace h={STEP} />
          <WorkingIndicator since={at(2)} />
          {tail.run && (
            <>
              {tail.queued.map((text, i) => (
                <div key={`q${i}`} className="flex flex-col">
                  <VSpace h={i === 0 ? STEP : HUMAN_RUN_STEP} />
                  <Message m={bubble(text, i, true)} />
                </div>
              ))}
              <VSpace h={HUMAN_RUN_STEP} />
              <div data-send-now-line={candidate.key}>
                <Line run={tail.run} onSend={click} pressed={pressed} boxReady={boxFocused && draft === ""} />
              </div>
            </>
          )}
        </div>
        <div data-thread-chat-footer className="border-t border-border/60 bg-panel">
          <div className="px-3 py-3" onFocus={() => setBoxFocused(true)} onBlur={() => setBoxFocused(false)}>
            <Composer
              surface="chatComposer"
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              onInterruptSubmit={forced}
              placeholder={placeholder}
              send={{ mode, onMode: setMode, running: true, staged: 0 }}
            />
          </div>
        </div>
      </div>
      <div className="mt-2 flex min-h-[16px] items-baseline gap-3 text-[11px] leading-[16px] text-muted-60">
        <span className="min-w-0 flex-1">{said}</span>
        {changed && (
          <button type="button" onClick={reset} className={`shrink-0 ${link}`}>
            Reset
          </button>
        )}
      </div>
    </div>
  )
}

function Section({ id, name, says, children }: { id: string; name: string; says: string; children: ReactNode }) {
  return (
    <section className="mb-14">
      <div className="mb-4 flex items-baseline gap-3">
        <span className="text-[13px] font-semibold text-muted-60">{id}</span>
        <h2 className="text-[15px] font-semibold text-fg">{name}</h2>
      </div>
      <p className="mb-5 max-w-[720px] text-[13px] leading-[20px] text-muted">{says}</p>
      <div className="flex gap-6 max-[1000px]:flex-col">{children}</div>
    </section>
  )
}

function Sheet() {
  return (
    <TooltipProvider>
      <div className="min-h-screen bg-panel px-10 py-10 text-sm text-fg max-[700px]:px-4">
        <div className="mx-auto max-w-[1180px]">
          <h1 className="mb-2 text-[20px] font-semibold">{CHORD} for Send now</h1>
          <p className="mb-3 max-w-[760px] text-[13px] leading-[20px] text-muted">
            Today {CHORD} only sends words typed in the prompt box; with the box empty it does nothing, and Send now under the
            queued messages has no key. In every candidate below, {CHORD} with nothing typed presses Send now — with the caret
            in the empty box or with focus anywhere else in the thread — and does exactly what a click would: a run sent to
            the queue goes to the agent&rsquo;s next step on the first press, and a run waiting for that step is pushed through
            on the next. With words typed, {CHORD} keeps today&rsquo;s meaning and sends them now.
          </p>
          <p className="mb-10 max-w-[760px] text-[13px] leading-[20px] text-muted">
            The candidates differ only in how the control shows the chord. Every frame is live: click into its prompt box and
            press {CHORD} with it empty, or type something and press Enter to queue another message. Reset puts a frame back.
          </p>
          {CANDIDATES.map((c) => (
            <Section key={c.key} id={c.key} name={c.name} says={c.says}>
              <CandidateFrame candidate={c} initial="steer" />
              <CandidateFrame candidate={c} initial="held" />
            </Section>
          ))}
        </div>
      </div>
    </TooltipProvider>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Sheet />
  </QueryClientProvider>,
)
