import { X } from "lucide-react"
import type { ReactElement, ReactNode } from "react"
import { PANE_HEADER_HEIGHT_CLASS } from "../../lib/paneHeaderHeight.ts"

// The one side-sheet header bar. A fixed-height row (the pane-header height, px-4) with the lucide close
// button LEADING, an optional icon, the title (carrying optional inline `meta` — e.g. a background
// shell's "running 3 min" — and/or a stacked `subtitle` line — e.g. a doc drawer's "<slug>.md"), and
// optional trailing `actions` (settings' "● unsaved"). Replaces six near-identical hand-rolled headers
// that had drifted in height (h-11 vs h-12), padding (px-3 / px-4 / px-5), title weight, and
// close-button padding.
//
// The X LEADS because every sheet slides out to the RIGHT: it sits at the edge the sheet leaves from,
// and the right end is left to the sheet's own controls (maintainer 2026-10-08). The thread drawer's
// header is not drawn here, so it shares the button through SHEET_CLOSE_BUTTON_CLASS and places it the
// same way.
//
// `initialFocus` stamps data-dialog-initial-focus on the close button for Radix/focus managers that
// query it (ThreadSheet's onOpenAutoFocus / registerDrawerFocus); omitted, the attribute is absent.
//
// `-ml-1` pulls the X's hover square 4px into the bar's padding, so its INK sits as far from the sheet's
// left edge as the thread header's trailing check sits from its right: 9 of the 27 box px are painted,
// and without the trim the X read 25.75px in against the check's 21. With it, 21.75 in both headers
// (the thread header's title group adds `pl-1` to its `px-3`, the same 16px as `px-4` here).
// lucide X at 15px, `getBoundingClientRect` of its paths, thread-header fixture at 1000px, 2026-10-08.
export const SHEET_CLOSE_BUTTON_CLASS = "-ml-1 icon-hover-outline shrink-0 rounded-md p-1.5 text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"

export function SheetHeader({
  title,
  subtitle,
  icon,
  meta,
  actions,
  onClose,
  initialFocus,
}: {
  title: string
  subtitle?: string
  icon?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  onClose: () => void
  initialFocus?: boolean
}): ReactElement {
  return (
    <header className={`flex ${PANE_HEADER_HEIGHT_CLASS} shrink-0 items-center gap-2.5 border-b border-border bg-panel px-4`}>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        {...(initialFocus ? { "data-dialog-initial-focus": "" } : {})}
        className={SHEET_CLOSE_BUTTON_CLASS}
      >
        <X size={15} />
      </button>
      {icon}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-[13px] font-medium" title={title}>
            {title}
          </span>
          {meta}
        </div>
        {subtitle && <span className="truncate text-[10px] text-muted-60">{subtitle}</span>}
      </div>
      {actions}
    </header>
  )
}
