// THE ARITHMETIC OF DRAGGING A RAIL SQUARE, with no DOM in it.
//
// The rail's drag is a uniform vertical list: every square is the same height and every gap is the
// same, which collapses "where would this land" from a hit-test against N boxes into one division.
// Keeping that arithmetic here — pure, and tested — is what lets the component own only the parts
// that genuinely need a browser: pointer capture, transforms, and the edge auto-scroll.

/** One square plus the gap below it: the distance the list shifts by when an item moves one slot. */
export const RAIL_STEP_PX = 48

/**
 * `list` with the item at `from` moved to `to`.
 *
 * Splice-out-then-splice-in, which is correct in both directions without a special case: removing
 * first renumbers everything after `from`, and `to` is expressed against the list the user is
 * LOOKING AT — which is the post-removal list, because the dragged square is not in its old slot.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

/**
 * Which slot the dragged square is currently over.
 *
 * From its own displacement rather than the pointer's: the square is what the eye tracks, and keying
 * on the pointer makes the drop depend on where inside the square you happened to grab it. Rounding
 * (not flooring) is what makes the swap happen at the HALFWAY point, so a square that has visibly
 * passed its neighbour has already taken its slot.
 */
export function dropIndex(fromIndex: number, deltaY: number, count: number, step = RAIL_STEP_PX): number {
  const moved = Math.round(deltaY / step)
  return Math.max(0, Math.min(count - 1, fromIndex + moved))
}

/**
 * How far square `index` must slide to make room, in px.
 *
 * Everything between the square's old slot and its new one shifts by exactly one step, towards the
 * gap the dragged square left behind. Squares outside that span do not move at all — which is what
 * makes a drag across a long rail read as a local insertion rather than the whole list sliding.
 */
export function shiftFor(index: number, fromIndex: number, toIndex: number, step = RAIL_STEP_PX): number {
  if (index === fromIndex) return 0
  if (toIndex > fromIndex && index > fromIndex && index <= toIndex) return -step
  if (toIndex < fromIndex && index >= toIndex && index < fromIndex) return step
  return 0
}

/** A row's box when a drag began, in any one vertical coordinate system. */
export interface RowSlot {
  top: number
  height: number
}

/**
 * Which slot a dragged ROW is over, in a list whose rows are not one height — the sidebar's pinned
 * band, where a title wraps to two lines and a thread's live sub-agents hang under it, so the
 * one-division `dropIndex` above has no step to divide by.
 *
 * The slot whose centre is nearest the held row's centre, against where every row sat when the drag
 * began. With equal heights that is `dropIndex` exactly; with unequal ones the swap lands halfway
 * between the two centres, so a two-line row need not travel its whole height to pass a one-line one.
 */
export function nearestSlot(slots: readonly RowSlot[], fromIndex: number, deltaY: number): number {
  const held = slots[fromIndex]
  if (!held) return fromIndex
  const centre = held.top + held.height / 2 + deltaY
  let best = fromIndex
  let bestDistance = Number.POSITIVE_INFINITY
  slots.forEach((slot, index) => {
    const distance = Math.abs(slot.top + slot.height / 2 - centre)
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  })
  return best
}

/**
 * The held row's displacement, kept inside the list: it can reach the first slot's top and the last
 * slot's bottom, and no further. A drop only ever lands IN the list, so a row drawn over whatever sits
 * below it would promise a place it cannot go.
 */
export function clampToSlots(slots: readonly RowSlot[], fromIndex: number, deltaY: number): number {
  const held = slots[fromIndex]
  const first = slots[0]
  const last = slots[slots.length - 1]
  if (!held || !first || !last) return 0
  return Math.max(first.top - held.top, Math.min(last.top + last.height - (held.top + held.height), deltaY))
}

/**
 * How far the OTHER rows shift to open the gap: the held row's own height plus the gap between rows,
 * which is what `shiftFor` takes as its step when the rows are not uniform.
 */
export function heldStep(slots: readonly RowSlot[], fromIndex: number): number {
  const held = slots[fromIndex]
  if (!held) return 0
  const [a, b] = slots
  const gap = a && b ? b.top - (a.top + a.height) : 0
  return held.height + gap
}

/**
 * How fast to scroll the band when the pointer nears its edge, in px per frame.
 *
 * Without this the rail is reorderable only within one screen of itself, which on a machine with
 * forty projects is not reorderable at all — the square you want to move to the top is usually not
 * on screen at the same time as the top. Ramps with depth into the zone so a small overshoot nudges
 * and a deliberate hold at the edge moves properly.
 */
export function edgeScrollVelocity(
  pointerY: number,
  bounds: { top: number; bottom: number },
  zone = 44,
  max = 14,
): number {
  const intoTop = bounds.top + zone - pointerY
  if (intoTop > 0) return -Math.min(max, (intoTop / zone) * max)
  const intoBottom = pointerY - (bounds.bottom - zone)
  if (intoBottom > 0) return Math.min(max, (intoBottom / zone) * max)
  return 0
}
