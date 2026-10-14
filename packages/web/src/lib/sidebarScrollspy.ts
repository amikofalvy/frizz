export type SidebarSectionGeometry = { id: string; top: number; bottom: number }

// How much of the viewport a card must cover to take the rail from a taller card still hanging above
// it. Half the screen is the point where the reader has demonstrably moved on (maintainer 2026-07-24).
export const SIDEBAR_SPY_COVERAGE = 0.5

// Which queue card the rail's reading rule points at, from card geometry alone.
//
// COVERAGE, not a reading line. This used to pick whichever card crossed a 12px line at the very top
// of the viewport, which meant a tall card kept the rail until it had scrolled ENTIRELY off screen —
// the reader could be looking at a full screen of the next card while the rail still marked the last
// one. The rule now is: the FIRST card that is either wholly on screen or already covering half the
// viewport, and only if no earlier card is still showing more of itself than that.
//
// The two clauses cover the two shapes a queue takes. Cards TALLER than the viewport hand over at the
// halfway point, exactly when the newcomer becomes the bigger half of the screen. Cards SHORTER than
// the viewport hand over when the previous one starts leaving, so the topmost fully-readable card
// holds the rail — which is also what makes a click-to-card landing stick, since that lands the target
// whole at the top of the screen.
//
// Geometry is the CARD ROOT, not the queue slot: the slot spans the root's bottom scroll-reserve
// margin (and until 2026-08-25 carried ~80px of inter-card gutter too), and crediting a card for empty
// space would let a card that is visually gone still count as "wholly on screen".
export function activeSidebarSection(
  sections: readonly SidebarSectionGeometry[],
  viewportHeight: number,
  atDocumentBottom = false,
): string | null {
  const onScreen = sections
    .map((section) => ({
      id: section.id,
      height: Math.max(0, section.bottom - section.top),
      visible: Math.min(section.bottom, viewportHeight) - Math.max(section.top, 0),
    }))
    .filter((card) => card.visible > 0)
  if (!onScreen.length) return null
  // A short final card can never win on coverage: the browser has exhausted its scroll range while a
  // taller predecessor still fills most of the screen. At that real boundary the reader has arrived at
  // the last queue item, so it takes the rail. Kept out of normal scrolling so an upcoming final card
  // cannot claim the rail merely for being near the viewport bottom.
  if (atDocumentBottom) return onScreen[onScreen.length - 1].id
  const dominant = viewportHeight * SIDEBAR_SPY_COVERAGE
  let leader = onScreen[0]
  for (const card of onScreen) {
    if (card.visible > leader.visible) leader = card
    // `>= leader.visible` (the running maximum, this card included) keeps a small card lower down from
    // stealing the rail just for fitting on screen while more of a partly-scrolled card is still shown.
    if (card.visible >= Math.min(dominant, card.height) && card.visible >= leader.visible) return card.id
  }
  return leader.id
}

// A click on a sidebar row scrolls to that row's queue card and pins the rail to it, so the rail can't
// flicker through the cards the jump passes over. This decides when the pin lets go: when the card has
// arrived at the landing, when it is gone, or when the reader has scrolled away from where the click
// left them. That last clause is what keeps a pin from outliving its click — the LAST card of a short
// queue can never reach the landing, because the document runs out of scroll first, and the rail used to
// stay frozen on it however far back up the queue the reader scrolled.
export function queueNavigationSettled(
  target: SidebarSectionGeometry | undefined,
  scrollY: number,
  landedY: number,
  landingTop: number,
): boolean {
  if (!target) return true
  if (target.top <= landingTop && target.bottom > landingTop) return true
  return Math.abs(scrollY - landedY) > 1
}

// Keep the active marker reachable without disturbing the page's scroll position. The result is a
// delta for the rail's own scrollTop, with a small breathing margin around the highlighted row.
export function railRevealDelta(
  railTop: number,
  railBottom: number,
  itemTop: number,
  itemBottom: number,
  margin = 8,
): number {
  if (itemTop < railTop + margin) return itemTop - railTop - margin
  if (itemBottom > railBottom - margin) return itemBottom - railBottom + margin
  return 0
}

// The queue cards on the board, as the reading rule above measures them, by the BORDERED ROOT rather than
// the slot (the slot is the fade wrapper and also spans the root's bottom scroll-reserve margin). Shared by
// the rail (Sidebar) and the number keys (lib/questionKeys.ts), so the card a bare digit answers is the
// card the rail marks.
//
// A LEAVING card is left out by default: a digit must not answer a question on a card that is already
// dissolving. The rail asks for it (`includeLeaving`), because a fading card still holds its full height
// under the reader's eyes until it unmounts, and leaving it out handed the rail to whatever else was on
// screen for the length of the fade: on every send from a card with one above it, the marker went to the
// card ABOVE for ~200ms and then to the card below (27 of 27 recordings, 2026-10-13). Which row the
// marker is drawn on while its card fades is `markerRow`'s decision, below.
export function queueCardGeometry({ includeLeaving = false }: { includeLeaving?: boolean } = {}): SidebarSectionGeometry[] {
  const selector = includeLeaving ? "[data-queue-card]" : "[data-queue-card][data-queue-leaving=\"false\"]"
  return [...document.querySelectorAll<HTMLElement>(selector)].flatMap((element) => {
    const id = element.dataset.queueCard
    if (!id) return []
    const { top, bottom } = (element.querySelector<HTMLElement>("[data-queue-card-root]") ?? element).getBoundingClientRect()
    return [{ id, top, bottom }]
  })
}

// WHICH ROW WEARS THE MARKER, given the card the reading rule picked and the rail's queue rows.
//
// The two are the same thing until the reader acts on the card they are reading. Then the ROW leaves the
// queue band in the click's own commit (a send moves it to Running, Mark as done to Done, a snooze to
// Snoozed) while the CARD stays under the reading rule for the 200ms of its fade. Drawn on the row the
// rule names, the marker rode that row into the Running band, where no row has a card (2-3 painted
// frames in every recording), before the rule caught up.
//
// So a marked row that has left the queue hands the marker to the row that takes its place: the next
// one down in the order the queue had while it was still in it, else the nearest one above. That is the
// card the dismissal lands at the top of the screen (captureScrollTarget in TodosView), so the marker is
// already where the reading rule will put it once the card unmounts. When the row below takes the
// departed row's own slot in the rail, the marker does not visibly move at all.
//
// `previous` is the queue's order the last time the marked row was in it. A row that was never in it (a
// pinned thread, whose row stays put in the Pinned band) keeps its marker.
export function markerRow(activeId: string | null, queue: readonly string[], previous: readonly string[]): string | null {
  if (!activeId || queue.includes(activeId)) return activeId
  const at = previous.indexOf(activeId)
  if (at < 0) return activeId
  for (let i = at + 1; i < previous.length; i++) if (queue.includes(previous[i])) return previous[i]
  for (let i = at - 1; i >= 0; i--) if (queue.includes(previous[i])) return previous[i]
  return null
}

// Has the document run out of scroll? The reading rule's `atDocumentBottom` argument.
export function scrolledToDocumentBottom(): boolean {
  const maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
  return maxScrollY > 0 && window.scrollY >= maxScrollY - 1
}
