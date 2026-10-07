// Mobile board actions share one 48px row and one cap-band alignment. A 1em symmetric lucide glyph
// on the label's baseline needs half the difference between em and cap height to centre its ink.
export const MOBILE_MENU_ACTION = "flex min-h-[48px] w-full items-center px-4 text-left active:bg-hover disabled:opacity-55"
export const MOBILE_MENU_LABEL = "flex w-full items-baseline gap-3 text-[16px] leading-[21px] text-fg"
// Sans at 16px and 32px: Settings, RefreshCw and ChevronRight all have 0px cap-band residual.
// RefreshCw → label reads 14.63px of ink spacing at 16px, using the menu's 12px box gap.
export const MOBILE_MENU_ICON = "size-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]"
// The 0.25em notification dot shares the label's cap-band centre, not the text line-box centre.
// Sans at 16px/32px: 0px residual; label → dot reads 8.77px of ink spacing at 16px (8px box gap).
export const MOBILE_MENU_NOTIFICATION = "size-[0.25em] shrink-0 self-baseline translate-y-[calc(0.125em_-_0.5cap)] rounded-full bg-accent"
