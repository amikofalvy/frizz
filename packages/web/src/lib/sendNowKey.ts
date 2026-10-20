import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { topThreadSlug } from "../store.ts"
import { isForcedSendChord } from "./composerKeyboard.ts"
import { pressSendNow } from "./deliverQueuedNow.ts"
import type { QueuedRun } from "./restReply.ts"

// ⌘⏎ PRESSES SEND NOW — the one under the queued messages (ChatView QueuedSendNow) — whenever there is
// nothing typed to send instead (maintainer 2026-10-19: "'Send Now' should also be triggerable with
// Command+Enter. That applies even if the focus is currently in the prompt box and you have nothing
// written"). It is the same press as a click, one step at a time (lib/deliverQueuedNow sendNowStep).
//
// WHERE THE CHORD COMES FROM, and which thread it presses:
//   · focus anywhere inside a thread's surface — its queue card, drawer or full page (ThreadSurface) —
//     presses that thread's, except from a field that edits something else (a question's text box, a
//     search box). The thread's own prompt box counts only while EMPTY: with anything in it the box
//     answers the chord itself, as its forced send, and swallows it even when it cannot send yet
//     (Composer), so it never reaches here.
//   · NOTHING focused — the chord lands on the page itself — presses the thread in the topmost open
//     drawer, or else the one thread on the page (the full page, or a queue with one card). With several
//     cards and nothing to say which, it presses nothing.
//
// Ctrl-Enter is the same chord off a Mac, as it is in the prompt box.

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])"

/** Does this keystroke, which reached a thread's surface, mean "press Send now"? */
export function isSendNowKey(event: KeyboardEvent, surface: Element): boolean {
  if (event.defaultPrevented || event.repeat || !isForcedSendChord(event)) return false
  const target = event.target
  // In the DOM, not just in React's tree: a dialog portalled out of the surface bubbles its keystrokes
  // through the surface's handlers, and a ⌘⏎ in a dialog is the dialog's.
  if (!(target instanceof Element) || !surface.contains(target)) return false
  const editable = target.closest(EDITABLE)
  if (!editable) return true
  return editable instanceof HTMLTextAreaElement && editable.closest("[data-thread-composer-box]") !== null && editable.value.trim() === ""
}

// Every mounted surface, for a chord that lands on the page with nothing focused.
type Mounted = { slug: string; press: () => boolean }
const mounted = new Set<Mounted>()

function onPageKey(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.repeat || !isForcedSendChord(event)) return
  const active = document.activeElement
  if (active && active !== document.body && active !== document.documentElement) return
  const entries = [...mounted]
  const top = topThreadSlug()
  const target = top
    ? entries.find((entry) => entry.slug === top)
    : new Set(entries.map((entry) => entry.slug)).size === 1 ? entries[0] : undefined
  if (target?.press()) event.preventDefault()
}

/** One per surface (ThreadSurface): the root's key handler, and the surface's place in the page-level
 *  fallback for as long as it is mounted. */
export function useSendNowKey(slug: string, run: QueuedRun): (event: ReactKeyboardEvent<HTMLElement>) => void {
  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => {
    const entry: Mounted = { slug, press: () => pressSendNow(slug, runRef.current) }
    if (mounted.size === 0) window.addEventListener("keydown", onPageKey)
    mounted.add(entry)
    return () => {
      mounted.delete(entry)
      if (mounted.size === 0) window.removeEventListener("keydown", onPageKey)
    }
  }, [slug])
  return useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (isSendNowKey(event.nativeEvent, event.currentTarget) && pressSendNow(slug, runRef.current)) event.preventDefault()
    },
    [slug],
  )
}
