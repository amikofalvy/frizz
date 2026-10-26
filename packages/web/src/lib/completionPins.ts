import type { ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast, type ToastAction } from "../store.ts"

// MARK AS DONE KEEPS THE PIN. A pin outranks Done (router setThreadPinned): the maintainer pins threads
// on purpose and marks them done, and wants them to stay on the shelf, visible and one click away
// (2026-10-26: "I often have a lot of things pinned intentionally, and I mark them as done. I want them
// to stay visible and obviously clickable"). Unpinning is the exception, so it is ASKED rather than
// done: the toast a pinned thread's completion shows carries an "Unpin" action, which the human can
// ignore. A dialog was passed on because it would cost a click on every pinned Done, the common case.

// Pinned on either shelf, the project board's or the Console's.
export function isPinned(thread: Pick<ThreadView, "pinnedAt" | "consolePinnedAt">): boolean {
  return typeof thread.pinnedAt === "string" || typeof thread.consolePinnedAt === "string"
}

// The completion toast's "Unpin" action: lifts the pin from every shelf the thread was on when it was
// marked done, so "Unpin" means off the pinned list everywhere.
export function unpinAction(thread: Pick<ThreadView, "id" | "sessionId" | "pinnedAt" | "consolePinnedAt">): ToastAction {
  const slug = thread.id
  const sessionId = thread.sessionId ?? ""
  return {
    label: "Unpin",
    run: () => {
      void (async () => {
        if (typeof thread.pinnedAt === "string") await rpc.setThreadPinned({ slug, sessionId, pinned: false })
        if (typeof thread.consolePinnedAt === "string") await rpc.setThreadConsolePinned({ slug, sessionId, pinned: false })
      })()
        .then(() => showToast("Unpinned"))
        .catch((error) => showToast(`Couldn’t unpin: ${(error as Error).message.slice(0, 80)}`))
    },
  }
}

// The toast every completion surface shows: the plain confirmation, plus "Unpin" on a pinned thread.
export function showCompletionToast(text: string, thread: Pick<ThreadView, "id" | "sessionId" | "pinnedAt" | "consolePinnedAt">): void {
  if (isPinned(thread)) showToast(text, { action: unpinAction(thread) })
  else showToast(text)
}
