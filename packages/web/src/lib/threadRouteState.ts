import type { BoardSnapshot, ThreadView } from "@frizz/shared"

export type ThreadRouteResolution =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "found"; ownership: "owned" | "foreign" | "legacy"; thread: ThreadView }

// A routed slug has three honest phases. Until the first authoritative board arrives it is loading,
// not an empty chat. Once authoritative, absence is an explicit not-found state. A present row keeps
// its ownership classification so foreign/legacy deep links can never inherit an owned Terminal.
//
// `find` is how the row is looked up. The callers pass the store's indexed lookup (store.ts
// threadBySlug): this runs on every render of a routed thread's sheet and page, and `find` walked the
// board up to the thread — through useBoard()'s tracking view, recording each thread it passed. A newly
// dispatched thread sits at the END of a board holding every thread the project has finished, so its
// page walked all of them on every delta of its own turn. The default is that walk, for a caller with a
// board of its own (a test, a fixture).
export function resolveThreadRoute(
  board: BoardSnapshot | null,
  slug: string,
  find: (board: BoardSnapshot, slug: string) => ThreadView | undefined = (b, s) => b.threads.find((candidate) => candidate.id === s),
): ThreadRouteResolution {
  if (!board) return { kind: "loading" }
  const thread = find(board, slug)
  if (!thread) return { kind: "missing" }
  const ownership = thread.kind !== "session" ? "legacy" : thread.foreign === true ? "foreign" : "owned"
  return { kind: "found", ownership, thread }
}
