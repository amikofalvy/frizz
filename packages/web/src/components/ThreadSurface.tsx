import { createContext, useContext, useMemo, type ComponentPropsWithRef, type ReactElement } from "react"
import type { ThreadView } from "@frizz/shared"
import type { ChatMessage } from "../hooks.ts"
import { useLiveAnswering, type LiveAnswering } from "../lib/answering.ts"
import { useFileDropZone, useFileIntakeHandle, type FileDropZone, type SurfaceFileDrop } from "../lib/fileDrop.ts"
import { SendScopeContext, useComposerSendHandle, useComposerSendPresent, useSendScope, type SendScope } from "../lib/sendScope.tsx"
import { QueueDismissContext, ThreadSlugContext, type SurfaceExit } from "../lib/threadContexts.ts"
import { RegisteredAnsweringProvider } from "./RegisteredQuestionCards.tsx"

// THE THREAD SURFACE — the one shell around a thread, wherever it is drawn. A thread is drawn in three
// places: its queue card (TodosView's QueueCard), its drawer and its full-screen page (both ChatView).
// Each of those lays its transcript out its own way — the card folds a turn's middle and lets the page
// scroll, the other two window a long transcript inside their own scroller — and that is ALL a surface
// decides. Everything that is true of THE THREAD rather than of a layout is wired here, once:
//
//   · the file drop zone: a file dropped anywhere on the surface goes into its prompt box (lib/fileDrop),
//   · the one send: the prompt box's handle and the scope its Send gathers answers through (lib/sendScope),
//   · the fenced-question controller (lib/answering useLiveAnswering) and the registered questions'
//     shared answering state (RegisteredAnsweringProvider),
//   · the thread's slug, for everything in the transcript that acts on its thread (ThreadSlugContext),
//   · how the surface leaves the page when its thread is handed back, where it does (QueueDismissContext).
//
// It exists because those were wired by hand in each shell, so a feature built in one was simply absent
// from the other and nothing said so: a file dropped anywhere on a queue card went into its prompt box
// from 2026-10-12, and the same drop on the drawer or the full-screen page opened the file in place of
// the app (maintainer 2026-10-13: "Why is there so much … stuff we accidentally implemented just for
// the cue card, or just for the sidebar drawer, or just for the full screen view? This shouldn't even be
// structurally possible"). The `/login` alias, the status ladder, the gap rule and the box's placeholder
// had each drifted the same way before it and each been pulled into a shared piece; this is the shell
// those pieces are assembled in.
//
// SO A NEW THREAD BEHAVIOUR GOES HERE, not into a surface's own component. The prompt box refuses to
// mount outside this shell (useThreadSurfaceBox), and threadSurface.guard.test.ts fails when a surface
// wires one of these for itself.

export interface ThreadSurfaceOptions {
  /** THE SURFACE LEAVES THE PAGE WHEN ITS THREAD IS HANDED BACK — the queue card, which dissolves on a
   *  reply, an answer, Mark as done or a snooze, and comes back when the server declines. Absent on a
   *  surface that stays (the drawer, the full-screen page). */
  exit?: SurfaceExit
  /** A file landed on the surface. For a surface whose prompt box may not be mounted — a collapsed queue
   *  card opens itself here, and the box takes the file as it mounts. */
  onFilesDropped?: () => void
}

export interface ThreadSurfaceState {
  slug: string
  /** The fenced-question controller for this surface's transcript. */
  answering: LiveAnswering
  /** Is this surface's prompt box mounted, so that its Send carries the staged answers? */
  promptBoxSends: boolean
  /** A file is being dragged over the surface right now. */
  fileOver: boolean
  /** The rest is `<ThreadSurface>`'s wiring, not a caller's. */
  exit: SurfaceExit | null
  sendScope: SendScope
  zone: FileDropZone["handlers"]
  box: ThreadSurfaceBox
}

/** What the surface hands its prompt box. */
export interface ThreadSurfaceBox {
  fileDrop: SurfaceFileDrop
}

const ThreadSurfaceBoxContext = createContext<ThreadSurfaceBox | null>(null)

/** The thread's prompt box reads its surface here. It throws rather than degrade: a prompt box mounted
 *  outside the shell would silently lack whatever the shell wires, which is the defect this exists to end. */
export function useThreadSurfaceBox(): ThreadSurfaceBox {
  const box = useContext(ThreadSurfaceBoxContext)
  if (!box) throw new Error("A thread's prompt box must be rendered inside a <ThreadSurface>")
  return box
}

/** One per surface, called by the component that draws the transcript. `messages` is the list that
 *  component renders, so a question's controller is found by the identity of the message it sits in. */
export function useThreadSurface(slug: string, messages: ChatMessage[], options: ThreadSurfaceOptions = {}): ThreadSurfaceState {
  const { exit, onFilesDropped } = options
  // Created BEFORE the answering controller, which sends through it.
  const composer = useComposerSendHandle()
  const promptBoxSends = useComposerSendPresent(composer)
  // A send from a surface that leaves takes it out of the page in the same gesture, and a refused one
  // puts it back (useLiveAnswering's onSent / onSendFailed). The focused control goes with the surface.
  const answering = useLiveAnswering(
    slug,
    messages,
    exit
      ? () => {
          ;(document.activeElement as HTMLElement | null)?.blur()
          exit.dismiss()
        }
      : undefined,
    { onSendFailed: exit?.cancel, composer },
  )
  const { stagedCount, takeAnswers } = answering
  const sendScope = useSendScope(composer, { stagedCount, takeAnswers })
  // The surface is the zone and its prompt box the intake (lib/fileDrop). Files given while no box is
  // mounted wait on the handle.
  const intake = useFileIntakeHandle()
  const drop = useFileDropZone((files) => {
    intake.give(files)
    onFilesDropped?.()
  })
  const box = useMemo<ThreadSurfaceBox>(() => ({ fileDrop: { over: drop.over, intake } }), [drop.over, intake])
  const dismiss = exit?.dismiss
  const cancel = exit?.cancel
  // Stable while the two callbacks are, so the fence buttons reading it do not re-render every frame.
  const stableExit = useMemo<SurfaceExit | null>(() => (dismiss && cancel ? { dismiss, cancel } : null), [dismiss, cancel])
  return { slug, answering, promptBoxSends, fileOver: drop.over, exit: stableExit, sendScope, zone: drop.handlers, box }
}

/** The surface's root element, inside everything the shell provides. Every other prop is the root
 *  `<div>`'s own; the drag handlers are the shell's. */
export function ThreadSurface({
  surface,
  thread,
  children,
  ...root
}: {
  surface: ThreadSurfaceState
  /** The thread as this surface draws it. */
  thread: ThreadView | undefined
} & Omit<ComponentPropsWithRef<"div">, "onDragOver" | "onDragLeave" | "onDrop">): ReactElement {
  return (
    <ThreadSlugContext.Provider value={surface.slug}>
      {/* OUTSIDE the answering provider, whose send reads it. */}
      <QueueDismissContext.Provider value={surface.exit}>
        <SendScopeContext.Provider value={surface.sendScope}>
          <RegisteredAnsweringProvider thread={thread}>
            <ThreadSurfaceBoxContext.Provider value={surface.box}>
              <div {...root} {...surface.zone} data-thread-surface={surface.slug}>
                {children}
              </div>
            </ThreadSurfaceBoxContext.Provider>
          </RegisteredAnsweringProvider>
        </SendScopeContext.Provider>
      </QueueDismissContext.Provider>
    </ThreadSlugContext.Provider>
  )
}
