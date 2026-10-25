import { SnoozeUntil, type CompletionUnpinned, type ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast, type ToastAction } from "../store.ts"

// MARK AS DONE UNPINS BY DEFAULT (server router completeThread): a finished thread left on the pinned
// shelf held its row above every live one until somebody came back to unpin it. Keeping the pin is the
// exception, offered two ways: the done card's quieter "Mark as done, keep pinned" beside its primary,
// and — from every surface, the header's bare check and the phone's swipe included — the "Keep pinned"
// action on the toast a completion that unpinned shows, which puts the pins back where they were.

// Pinned on either shelf — the project board's or the Console's — so a Done here would lift a pin. It
// is what the buttons' labels key on; the server's own read is what decides.
export function completionUnpins(thread: Pick<ThreadView, "pinnedAt" | "consolePinnedAt">): boolean {
  return typeof thread.pinnedAt === "string" || typeof thread.consolePinnedAt === "string"
}

// The label every labelled Mark-as-done button wears, so a pinned thread's says what it will do.
export function markDoneLabel(thread: Pick<ThreadView, "pinnedAt" | "consolePinnedAt">): string {
  return completionUnpins(thread) ? "Mark as done & unpin" : "Mark as done"
}

// Put back the pins a completion lifted, each at the instant it held, so the thread returns to its own
// place on each shelf rather than the bottom. An instant the pin RPC would refuse (a pre-canonical
// value) falls back to a fresh pin: the thread is still kept pinned, just last. Throws on a failed write.
export async function restoreUnpinned(slug: string, sessionId: string, unpinned: CompletionUnpinned): Promise<void> {
  const at = (instant: string) => (SnoozeUntil.safeParse(instant).success ? instant : undefined)
  if (unpinned.pinnedAt !== null) await rpc.setThreadPinned({ slug, sessionId, pinned: true, at: at(unpinned.pinnedAt) })
  if (unpinned.consolePinnedAt !== null) {
    await rpc.setThreadConsolePinned({ slug, sessionId, pinned: true, at: at(unpinned.consolePinnedAt) })
  }
}

// The toast's "Keep pinned" action for a completion that lifted a pin.
export function keepPinnedAction(slug: string, sessionId: string, unpinned: CompletionUnpinned): ToastAction {
  return {
    label: "Keep pinned",
    run: () => {
      restoreUnpinned(slug, sessionId, unpinned)
        .then(() => showToast("Kept pinned"))
        .catch((error) => showToast(`Couldn’t keep it pinned: ${(error as Error).message.slice(0, 80)}`))
    },
  }
}
