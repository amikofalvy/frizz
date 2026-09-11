import { ExternalLink, FileText } from "lucide-react"
import type { ThreadLinkView } from "@frizz/shared"
import { CHILD_ARROW, CHILD_ARROW_CLASS } from "../lib/childOps.ts"
import { openLocalPath } from "../lib/local-file-links.ts"

// The activity-row grammar, without a liveness marker or a trailing open icon.
// THE ROW'S BOX IS THE CHILD-OP ROW'S BOX: no vertical padding and the inherited line-height, so a
// File/Link row measures exactly what the ⤷ AGENT / ⤷ SHELL rows above it measure (17.25px on the
// strip's 2px gap). It shipped with `py-0.5 leading-5`, which made each of these rows 25px against
// 17.25px and the column visibly looser than the live rows it continues (maintainer 2026-09-11:
// "It should be the exact same spacing and padding"). `items-baseline` stays: the icon's
// `self-baseline` cap-band correction below has nothing to align to on an `items-center` row.
// Ink gaps measured at dsf 6 in both fonts: arrow→icon 6.85–8.47px, icon→kind 7–7.84px.
// The wider kind→label space is a fixed column, keeping labels aligned across Link and File.
const ROW = "group flex min-w-0 items-baseline gap-1.5 rounded-sm text-left text-[11.5px] outline-none focus-visible:ring-1 focus-visible:ring-fg/60"
// Both glyphs are symmetric vertically; the resolved cap height follows the font setting.
// Measured ink-to-cap residual: 0px in sans and mono, at desktop and 390px widths.
// `-mt-[1em]` collapses the icon's OUTER box onto its bottom edge — the edge a baseline-aligned svg
// hangs from. A baseline-aligned flex item counts its whole outer box above the baseline, and the
// mono label's ascent (≈11.2px at 11.5px) is shorter than the 1em icon, so without the trim the icon
// set the row 0.5px taller than an AGENT row and pushed the label 0.5px down with it (sans, whose
// ascent is 13px, never showed it). The border box and the ink do not move; only what the row's
// height arithmetic sees does.
const ICON = "h-[1em] w-[1em] -mt-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)] text-muted/45"

export function ThreadLinks({ links }: { links: readonly ThreadLinkView[] }) {
  if (!links.length) return null
  return (
    <div data-thread-links aria-label="Registered links" className="mt-2 flex min-w-0 flex-col gap-0.5 border-t border-border pt-1.5">
      {links.map((link) => {
        const isUrl = link.kind === "link"
        const Icon = isUrl ? ExternalLink : FileText
        const content = <>
          <span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span>
          <Icon aria-hidden className={ICON} />
          <span data-link-kind className="petite-caps w-[33px] shrink-0 text-[9px] text-muted/45">{isUrl ? "Link" : "File"}</span>
          <span data-link-label className="min-w-0 flex-1 truncate text-muted/70 group-hover:text-fg/80 group-hover:underline">{link.label}</span>
          {/* `-mb-[0.5em]`: the destination is mono at 10px in a 15px line box whose baseline sits at
              ~60% of it, so beside a SANS label (baseline at ~75% of ITS box) it hung 1.75px below the
              label's line box and made the Link row 19px against every other row's 17.25px. The
              negative margin trims what the row's height arithmetic sees; the box itself — and so
              what `truncate` clips — is unchanged. */}
          {isUrl && <span data-link-destination className="font-mono-keep ml-auto -mb-[0.5em] max-w-[45%] min-w-0 truncate text-right text-[10px] text-muted/45">{link.target}</span>}
        </>
        return isUrl ? (
          <a key={link.id} data-thread-link={link.id} href={link.target} target="_blank" rel="noopener noreferrer" title={link.target} className={ROW} onClick={(event) => event.stopPropagation()}>{content}</a>
        ) : (
          <button key={link.id} data-thread-link={link.id} type="button" title={link.target} className={`${ROW} cursor-pointer`} onClick={(event) => { event.stopPropagation(); openLocalPath(link.target) }}>{content}</button>
        )
      })}
    </div>
  )
}
