import type { BoardSnapshot, ThreadView, BoardMeta, BoardDelta, ThreadSlug } from "./index.ts"

// Keyed thread-level delta engine — the server side of the /events delta protocol. Type-only imports
// above (erased at compile time) so this file has NO runtime dependency on index.ts and can't form an
// import cycle with it, even though index.ts re-exports these symbols.
//
// The board's only heavy field is `threads: ThreadView[]`, keyed by `id`. So the right diff here is NOT
// generic JSON-patch — it is a trivial keyed compare of per-thread serialized JSON. The differ holds the
// last-BROADCAST state (per-thread JSON + a serialized copy of the board-level fields) and, on a fresh
// snapshot, emits only what changed. Because each upsert carries the WHOLE ThreadView (not a sub-field
// patch), a client applying deltas in order reproduces server state exactly — no drift to accumulate;
// the only failure a delta stream can suffer is a DROPPED delta, which the seq counter makes detectable.

function metaOf(b: BoardSnapshot): BoardMeta {
  return {
    projectDir: b.projectDir,
    projectName: b.projectName,
    projectLabel: b.projectLabel,
    errors: b.errors,
    warnings: b.warnings,
    // Normalize undefined→[] so metaS serialization is stable (an absent vs empty errorItems never
    // reads as a spurious meta change) and the structured repair list survives every delta.
    errorItems: b.errorItems ?? [],
  }
}

// The shape the differ hands back — the payload of a `board-delta` event minus the type/bootId envelope.
export type BoardDiff = { seq: number; upserts: ThreadView[]; removed: ThreadSlug[]; meta?: BoardMeta }

export class BoardDiffer {
  // id -> the last-emitted serialized ThreadView JSON, plus the ThreadView OBJECT that serialization was
  // taken from. A producer that hands back the same object for an unchanged thread (the server board
  // memoizes archived threads' views) costs a map lookup here instead of a JSON.stringify — on a
  // 5,000-thread board the stringify pass alone was 30ms of every refresh. This is sound only because a
  // ThreadView is never mutated once it has been handed to the differ: the board builds a new object for
  // any change, and nothing downstream edits a snapshot's threads. A producer that did edit one in place
  // would have its change silently dropped.
  //
  // Updated in place, so an unchanged board allocates nothing per thread. `seen` is the diff that last
  // saw the id; an entry a diff did not see was removed.
  private threads = new Map<string, { json: string; object: ThreadView; seen: number }>()
  // serialized BoardMeta of the last snapshot (empty = never emitted).
  private meta = ""
  private seq = 0
  private pass = 0

  // The seq the last emitted diff carried (= the seq a fresh connect keyframe must advertise, since the
  // keyframe reflects the same committed state). 0 before anything has been diffed.
  currentSeq(): number {
    return this.seq
  }

  // Compute the delta of `next` vs. the last-emitted state. Returns null when NOTHING changed — the
  // caller must then NOT publish (this is the dedupe that keeps a 1s tailer tick from streaming
  // identical frames). On a real change it COMMITS the new state, bumps seq, and returns the diff.
  //
  // The per-thread entries are written as they are compared. That is the same commit: when the diff is
  // null every entry holds the string it held before (an object that serialized identically may have
  // replaced its predecessor, which is only a cheaper key for the next comparison).
  diff(next: BoardSnapshot): BoardDiff | null {
    const pass = ++this.pass
    const upserts: ThreadView[] = []
    // Distinct ids this diff saw. Counted, not taken from next.threads.length, so the removal sweep below
    // stays exact whatever the snapshot holds.
    let seen = 0
    for (const t of next.threads) {
      const entry = this.threads.get(t.id)
      if (entry && entry.object === t) {
        if (entry.seen !== pass) seen++
        entry.seen = pass
        continue
      }
      const json = JSON.stringify(t)
      if (!entry) {
        this.threads.set(t.id, { json, object: t, seen: pass })
        seen++
        upserts.push(t)
        continue
      }
      if (entry.seen !== pass) seen++
      if (entry.json !== json) {
        entry.json = json
        upserts.push(t)
      }
      entry.object = t
      entry.seen = pass
    }
    const removed: string[] = []
    if (this.threads.size > seen) {
      for (const [id, entry] of this.threads) {
        if (entry.seen === pass) continue
        removed.push(id)
        this.threads.delete(id)
      }
    }

    const meta = metaOf(next)
    const metaS = JSON.stringify(meta)
    const metaChanged = metaS !== this.meta

    if (upserts.length === 0 && removed.length === 0 && !metaChanged) return null

    this.meta = metaS
    this.seq += 1
    return metaChanged ? { seq: this.seq, upserts, removed, meta } : { seq: this.seq, upserts, removed }
  }
}

// Apply a delta to a board IN PLACE — the client side. Mutates `board.threads` (upsert / splice) and
// the board-level fields directly, which works identically on a plain BoardSnapshot (tests) and on a
// valtio proxy (the store): the in-place ops trigger valtio's fine-grained reactivity, which is the
// audit's S2 fix (no wholesale replace → no full-list re-render churn). Render ORDER is unaffected —
// the client re-sorts every render (sortThreads/listedThreads), so array position is immaterial.
//
// `positions`, when given, is a table of id → index that the CALLER keeps for this board's threads
// across deltas, so an upsert costs one lookup rather than a walk of every thread on the board (the
// store's board holds every thread the project ever finished; at 5,000 the walk, through valtio's
// proxy, was ~4ms of every delta). It is trusted only as far as it checks out: a slot whose id is not
// the one the table names, or an id it does not name at all, sends the table back to a full rebuild,
// so a table that drifted (another writer, a different board) costs a walk, never a wrong slot or a
// duplicate. Upserts keep it current; a removal shifts every later slot, so it is rebuilt after one.
export function applyBoardDelta(
  board: BoardSnapshot,
  delta: Pick<BoardDelta, "upserts" | "removed" | "meta">,
  positions?: Map<string, number>,
): void {
  if (delta.upserts.length) {
    const pos = positions ?? new Map<string, number>()
    const rebuild = () => {
      pos.clear()
      for (let i = 0; i < board.threads.length; i++) pos.set(board.threads[i].id, i)
    }
    let fresh = !positions || pos.size !== board.threads.length
    if (fresh) rebuild()
    for (const t of delta.upserts) {
      let i = pos.get(t.id)
      // A miss is checked as hard as a mismatch: a table describing some other board could lack an id
      // this one holds, and trusting the miss would push a second copy. A new thread is rare (a
      // dispatch), so the walk it costs is too.
      if (!fresh && (i === undefined || board.threads[i]?.id !== t.id)) {
        rebuild()
        fresh = true
        i = pos.get(t.id)
      }
      if (i === undefined) {
        pos.set(t.id, board.threads.length)
        board.threads.push(t)
      } else board.threads[i] = t
    }
  }
  if (delta.removed.length) {
    const rm = new Set(delta.removed)
    for (let i = board.threads.length - 1; i >= 0; i--) if (rm.has(board.threads[i].id)) board.threads.splice(i, 1)
    if (positions) {
      positions.clear()
      for (let i = 0; i < board.threads.length; i++) positions.set(board.threads[i].id, i)
    }
  }
  if (delta.meta) {
    board.projectDir = delta.meta.projectDir
    board.projectName = delta.meta.projectName
    board.projectLabel = delta.meta.projectLabel
    board.errors = delta.meta.errors
    board.warnings = delta.meta.warnings
    board.errorItems = delta.meta.errorItems
  }
}

// Client seq-gap decision (pure, so it is unit-tested without a DOM). Given the last-applied seq
// (-1 = no keyframe adopted yet) and an incoming delta's seq:
//   - IGNORE  a delta the keyframe already covers (a buffered duplicate: seq ≤ currentSeq).
//   - APPLY   the exact next delta (seq === currentSeq + 1).
//   - RESYNC  when there is no keyframe yet, or a delta was dropped (seq > currentSeq + 1) — incremental
//             state can no longer be trusted, so the client reconnects for a fresh keyframe.
export function deltaAction(currentSeq: number, deltaSeq: number): "apply" | "ignore" | "resync" {
  if (currentSeq < 0) return "resync"
  if (deltaSeq <= currentSeq) return "ignore"
  if (deltaSeq === currentSeq + 1) return "apply"
  return "resync"
}

// Pure boot-id reload decision (unit-tested). `known` = the boot id this page first recorded (null if
// none yet); `incoming` = the boot id on a fresh server frame/response.
//   - NOOP   when there's no incoming id (pre-restart server / unknown), or it matches what we know.
//   - RECORD the id on first sight (nothing to compare against yet).
//   - ADOPT a different id in place. The board transport obtains a new keyframe; mounted UI state
//     remains intact instead of being discarded by document navigation.
// A boot transition is transport information, not a navigation request.  The board connection will
// acquire a fresh keyframe after a server restart; forcing a document reload here destroys local UI
// state (notably an in-progress queue reply) exactly when a board delta is arriving.
export function bootReloadDecision(known: string | null, incoming: string | null | undefined): "record" | "noop" | "adopt" {
  if (!incoming) return "noop"
  if (known === null) return "record"
  if (known === incoming) return "noop"
  return "adopt"
}
