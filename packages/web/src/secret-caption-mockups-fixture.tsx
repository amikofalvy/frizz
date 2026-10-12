// MOCKUP SHEET — the caption under a SECRET question's password field, with a lock.
//
// Not a test and not shipped UI: a design surface. Each variant renders the secret card on the REAL card
// chrome and stylesheet, beside the phone answer sheet's reading of the same box, so a pick here is a
// pick about what ships. The caption today is a bare muted line capped at 60% of the card's width
// (QuestionBlockCard, RegisteredAnswerSheet's SecretText); every variant below drops the cap and adds a
// lock (maintainer 2026-10-12: "It needs to have a little lock icon. It can go full width").
//
//   nubx vite --port 5477 --strictPort      (from packages/web)
//   http://localhost:5477/secret-caption-mockups-fixture.html
//
// THE LOCK SITS ON THE CAP BAND, not on the box centre: it is 1em tall and `self-baseline` inside an
// `items-baseline` row, lifted by `0.5em − 0.5cap` — the browser's own cap height, so it holds at the
// card's 11px and the sheet's 13px alike. A wrapped caption hangs under its TEXT, not under the lock.
import type { ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { KeyRound, Lock, LockKeyhole, ShieldCheck, type LucideIcon } from "lucide-react"
import { TranscriptCard } from "./components/TranscriptCard.tsx"
import { LinkedHtml } from "./components/LinkedHtml.tsx"
import { useMarkdownHtml } from "./lib/useMarkdown.ts"
import "./styles.css"

const CONTEXT =
  "A NEW OpenRouter management key for Pullfrog production: open https://openrouter.ai/settings/management-keys, click Create New Key, name it vercel-production-2026-10-09, and paste the key here."
const COPY = "Held in memory on the machine running Frizz and handed to one command, once. The worker never sees it."

// A 1em mark on the text's cap band (see the header).
const ON_CAP = "size-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]"

type Where = "card" | "sheet"
type Variant = {
  id: string
  name: string
  note: string
  // The field and its caption, drawn for one surface. `filled` shows the box holding a pasted value.
  field: (where: Where, filled: boolean) => ReactNode
}

// ── the field as it ships today, per surface ─────────────────────────────────────────────────────
function CardInput({ filled, className = "" }: { filled: boolean; className?: string }) {
  return (
    <input
      type="password"
      readOnly
      value={filled ? "sk-or-v1-0123456789abcdef0123456789" : ""}
      placeholder="Paste the value…"
      className={`block w-full rounded-md border py-1.5 pl-3 pr-3 text-[12px] leading-snug text-fg/90 outline-none placeholder:text-muted-80 ${
        filled ? "border-selection-border bg-selection" : "border-border bg-transparent"
      } ${className}`}
    />
  )
}
function SheetInput({ filled, className = "" }: { filled: boolean; className?: string }) {
  return (
    <input
      type="password"
      readOnly
      value={filled ? "sk-or-v1-0123456789abcdef0123456789" : ""}
      placeholder="Paste the value…"
      className={`block w-full rounded-[12px] border border-border-strong bg-bg px-3 py-[11px] text-[16px] leading-[22px] text-fg outline-none placeholder:text-faint ${className}`}
    />
  )
}
const Input = ({ where, filled, className }: { where: Where; filled: boolean; className?: string }) =>
  where === "card" ? <CardInput filled={filled} className={className} /> : <SheetInput filled={filled} className={className} />

// The caption's type, per surface, exactly as each ships.
const TYPE: Record<Where, string> = {
  card: "text-[11px] leading-snug",
  sheet: "text-[13px] leading-[18px]",
}
const TONE: Record<Where, string> = { card: "text-muted-70", sheet: "text-muted" }

function LockLine({ where, icon: Icon = Lock, iconTone, gap, className = "" }: {
  where: Where
  icon?: LucideIcon
  iconTone?: string
  gap: string
  className?: string
}) {
  return (
    <div data-caption className={`flex items-baseline ${gap} ${TYPE[where]} ${TONE[where]} ${className}`}>
      <Icon aria-hidden strokeWidth={2.25} className={`${ON_CAP} ${iconTone ?? ""}`} />
      <span className="min-w-0 flex-1 text-pretty">{COPY}</span>
    </div>
  )
}

const VARIANTS: Variant[] = [
  {
    id: "now",
    name: "Today",
    note: "No lock, capped at 60% of the card. For reference.",
    field: (where, filled) => (
      <>
        <Input where={where} filled={filled} />
        <div className={`${where === "card" ? "mt-1.5 max-w-[60%]" : "mt-2"} ${TYPE[where]} ${TONE[where]}`}>{COPY}</div>
      </>
    ),
  },
  {
    id: "A",
    name: "Hanging lock",
    note: "The lock leads the caption in the caption's own tone; a wrapped line hangs under the text. Full width, left edge flush with the field.",
    field: (where, filled) => (
      <>
        <Input where={where} filled={filled} />
        <LockLine where={where} gap="gap-[0.25em]" className={where === "card" ? "mt-1.5" : "mt-2"} />
      </>
    ),
  },
  {
    id: "B",
    name: "Hanging lock, under the field's text",
    note: "As A, but the caption starts where the field's own text starts, so the lock sits under the placeholder's first letter.",
    field: (where, filled) => (
      <>
        <Input where={where} filled={filled} />
        <LockLine where={where} gap="gap-[0.25em]" className={where === "card" ? "mt-1.5 pl-[13px] pr-3" : "mt-2 pl-[13px] pr-3"} />
      </>
    ),
  },
  {
    id: "C",
    name: "Green lock",
    note: "As A, with the lock in the success green — the browser-padlock reading of \"this is safe\". The text stays muted.",
    field: (where, filled) => (
      <>
        <Input where={where} filled={filled} />
        <LockLine where={where} gap="gap-[0.25em]" iconTone="text-success" className={where === "card" ? "mt-1.5" : "mt-2"} />
      </>
    ),
  },
  {
    id: "D",
    name: "Note strip",
    note: "The caption becomes a quiet recessed strip of its own under the field, lock leading. Reads as a notice rather than a footnote.",
    field: (where, filled) => (
      <>
        <Input where={where} filled={filled} />
        <LockLine
          where={where}
          gap="gap-[0.25em]"
          className={
            where === "card"
              ? "mt-1.5 rounded-md border border-border bg-bg/50 px-3 py-1.5"
              : "mt-2 rounded-[12px] border border-border bg-bg/50 px-3 py-[9px]"
          }
        />
      </>
    ),
  },
  {
    id: "E",
    name: "Joined to the field",
    note: "Field and caption share one border: the caption is the field's footer, divided by a hairline. Says plainly that the note is about THIS box.",
    field: (where, filled) => (
      <div
        className={`overflow-hidden border ${where === "card" ? "rounded-md" : "rounded-[12px]"} ${
          filled && where === "card" ? "border-selection-border" : where === "card" ? "border-border" : "border-border-strong"
        }`}
      >
        <Input where={where} filled={filled} className="rounded-none border-0" />
        <LockLine
          where={where}
          gap="gap-[0.25em]"
          className={`border-t ${where === "card" ? "border-border bg-bg/40 px-3 py-1.5" : "border-border bg-panel-2 px-3 py-[9px]"}`}
        />
      </div>
    ),
  },
]

// The secret card, on the real chrome, carrying one variant's field.
function Card({ v, filled }: { v: Variant; filled: boolean }) {
  const html = useMarkdownHtml(CONTEXT)
  return (
    <TranscriptCard tone="neutral" surface="question" label="Secret">
      <div className="text-fg">
        <LinkedHtml className="md-body" html={html} />
      </div>
      <div className="mt-2">{v.field("card", filled)}</div>
    </TranscriptCard>
  )
}

// The phone answer sheet's secret step: its question prose and the box, on the sheet's panel.
function Sheet({ v }: { v: Variant }) {
  const html = useMarkdownHtml(CONTEXT)
  return (
    <div className="w-[390px] shrink-0 overflow-hidden rounded-t-[14px] border-t border-border-strong bg-panel pb-5">
      <div aria-hidden className="mx-auto mt-[6px] mb-[6px] h-[5px] w-[36px] rounded-full bg-muted/35" />
      <LinkedHtml className="px-[18px] pb-3 pt-1 text-[17px] font-semibold leading-[23px] text-fg" html={html} />
      <div className="px-[18px]">{v.field("sheet", false)}</div>
    </div>
  )
}

function Section({ v }: { v: Variant }) {
  return (
    <section data-variant={v.id} className="flex flex-col gap-3 border-t border-border pt-6">
      <div>
        <div className="text-[14px] font-semibold text-fg">
          {v.id === "now" ? v.name : <><span className="text-muted">{v.id}</span> · {v.name}</>}
        </div>
        <div className="mt-0.5 max-w-[780px] text-[12.5px] leading-snug text-muted">{v.note}</div>
      </div>
      <div className="flex flex-wrap items-start gap-6">
        <div data-surface="card" className="card-md flex w-[560px] flex-col gap-3">
          <Card v={v} filled={false} />
          <Card v={v} filled />
        </div>
        <div data-surface="sheet">
          <Sheet v={v} />
        </div>
      </div>
    </section>
  )
}

// The glyph itself, in A's setting: four marks a "kept secret" could wear.
const GLYPHS: { name: string; icon: LucideIcon }[] = [
  { name: "Lock", icon: Lock },
  { name: "LockKeyhole", icon: LockKeyhole },
  { name: "KeyRound", icon: KeyRound },
  { name: "ShieldCheck", icon: ShieldCheck },
]

function Glyphs() {
  return (
    <section data-variant="glyphs" className="flex flex-col gap-3 border-t border-border pt-6">
      <div>
        <div className="text-[14px] font-semibold text-fg">Which glyph</div>
        <div className="mt-0.5 text-[12.5px] leading-snug text-muted">Every variant above uses lucide's Lock. The alternatives, in A's setting.</div>
      </div>
      <div className="card-md grid w-[560px] grid-cols-1 gap-2 rounded-lg border border-border bg-panel-2 p-4">
        {GLYPHS.map((g) => (
          <div key={g.name} className="flex items-baseline gap-3">
            <span className="w-[84px] shrink-0 text-[11px] text-muted">{g.name}</span>
            <LockLine where="card" icon={g.icon} gap="gap-[0.25em]" className="min-w-0 flex-1" />
          </div>
        ))}
      </div>
    </section>
  )
}

createRoot(document.getElementById("root")!).render(
  <div className="mx-auto flex max-w-[1060px] flex-col gap-8 p-8">
    <header>
      <h1 className="text-[18px] font-semibold text-fg">Secret question — the caption, with a lock</h1>
      <p className="mt-1 max-w-[780px] text-[13px] leading-snug text-muted">
        Each variant on the desktop card (empty, then holding a pasted value) and on the phone answer sheet. Every variant
        runs full width; the lock sits on the caption's cap band and a wrapped line hangs under the text.
      </p>
    </header>
    {VARIANTS.map((v) => <Section key={v.id} v={v} />)}
    <Glyphs />
  </div>,
)
