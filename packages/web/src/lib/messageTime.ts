// WHEN A MESSAGE WAS SAID — the transcript's two readings of it.
//
// THE HOVER. Every message carries its instant as a native tooltip, `Today at 8:33 AM`, on every
// surface that draws one (ChatView's Message). Native because a `title` is drawn by the browser above
// the page, so it can never sit on top of the next bubble — the defect that retired the last hover
// reading (2026-10-09: "These fucking time stamps are overlapping with the message blocks").
//
// THE ONE READING ON SCREEN. A rest the human came back to after a long wait: the "Agent rested" hairline
// above their reply becomes `Today · 8:33 AM`, the instant they replied. That seam is the only place a
// thread's time is news — a stretch of work starting after a park — and the hairline was already drawn
// there, so the date takes its place rather than stacking under it.
//
// Both replaced TIME BREAKS (2026-10-09 → 2026-10-19): a centred `Today 10:51 AM` line at the top of every
// surface and after every 20m pause, which put two time readings at that seam — "Agent rested · 3d ago"
// and the break under it — and one on every other pause (maintainer 2026-10-19: "i hate the date/time
// readouts so much … if there's a big gap between an agent pause and the next steer, we should use a
// hairline instead that says TODAY · 8:35AM … instead of the agent rested thing").

/** A wait at least this long between a rest and the human's reply dates the reply. */
export const REST_GAP_MS = 20 * 60_000

function instant(at: string | undefined): number | null {
  const ms = at ? Date.parse(at) : NaN
  return Number.isFinite(ms) ? ms : null
}

/**
 * The instant the human came back to a rested agent, when the wait is worth dating: REST_GAP_MS or
 * longer, or across midnight (11:58 PM to 12:03 AM is a new day, and a bare "Agent rested" would not say
 * so). Null for a quick reply, and when either instant is unknown — a legacy transcript recorded before
 * `at` was on the wire keeps its plain hairline.
 */
export function restGapAt(restAt: string | undefined, replyAt: string | undefined): string | null {
  const rest = instant(restAt)
  const reply = instant(replyAt)
  if (rest === null || reply === null) return null
  const newDay = new Date(rest).toDateString() !== new Date(reply).toDateString()
  return newDay || reply - rest >= REST_GAP_MS ? replyAt! : null
}

function daysBefore(when: Date, now: Date): number {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.round((startOf(now) - startOf(when)) / 86_400_000)
}

/**
 * The hairline's words: `{ day: "Today", time: "8:33 AM" }`.
 *
 * Today and Yesterday by name, a weekday inside the last week, then a short date — with the year only
 * when it is not this year, the same rule the rest of the app's dates follow. `now` and `locale` exist
 * for the test; production passes neither.
 */
export function dayAndTime(at: string, now: Date = new Date(), locale?: string): { day: string; time: string } {
  const when = new Date(Date.parse(at))
  const time = when.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
  const ago = daysBefore(when, now)
  const day = ago === 0 ? "Today"
    : ago === 1 ? "Yesterday"
    : ago > 1 && ago < 7 ? when.toLocaleDateString(locale, { weekday: "long" })
    : when.toLocaleDateString(locale, when.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" })
  return { day, time }
}

/**
 * The hover: `Today at 8:33 AM`, `Yesterday at 4:12 PM`, `Friday, October 16 at 4:12 PM`, and the year
 * once it is not this one. A tooltip is read alone, so past yesterday it names the date in full rather
 * than a bare weekday the reader has to place. Null when the message has no instant.
 */
export function messageStamp(at: string | undefined, now: Date = new Date(), locale?: string): string | null {
  const ms = instant(at)
  if (ms === null) return null
  const when = new Date(ms)
  const time = when.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
  const ago = daysBefore(when, now)
  const day = ago === 0 ? "Today"
    : ago === 1 ? "Yesterday"
    : when.toLocaleDateString(locale, when.getFullYear() === now.getFullYear()
      ? { weekday: "long", month: "long", day: "numeric" }
      : { weekday: "long", month: "long", day: "numeric", year: "numeric" })
  return `${day} at ${time}`
}
