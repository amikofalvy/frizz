import type { BoardState } from "@frizz/shared"

// THE BOARD IS READ OVER HTTP AND KEPT CURRENT OVER THE SOCKET.
//
// The board is the one big payload a page receives: every thread the project ever finished, 14MB of
// JSON at 5,000 threads. It came down the socket as the connect keyframe until 2026-10-14, and a
// browser receiving one socket message that size spent ~350ms of its main thread on it, where the same
// bytes as a gzipped HTTP response cost ~50ms (the network stack decodes a fetch off the main thread).
// Every page load read it twice besides — once as the startup seed over HTTP, once as the keyframe —
// and a board past the socket's 4 MiB frame limit could not come down it at all, which sent the tab to
// SSE for the rest of its life.
//
// So the socket carries only DELTAS. The page reads the board over HTTP (`boardState`, which names the
// boot and the seq it reflects), and when its socket says hello it names the (boot, seq) it holds with a
// {t:"board"} message. The server replays every delta after that seq from a ring of recent ones, then
// streams live ones (server app-socket.ts, board.ts DeltaRing). When the ring cannot cover the gap —
// another boot, a seq it has rolled past, a seq it has never reached — it answers `board-resync`, and
// this reads the board over HTTP again and names the new seq. A delta that skips a seq (deltaAction)
// does the same. A dropped socket keeps the board and its seq, so a reconnect replays the gap rather
// than reading the board again.
//
// This class is the part of that both live feeds share: a project page's socket (socket.ts) and each
// of the Console's per-project sockets (consoleFeed.ts). It decides WHEN to read and WHAT to name; the
// feed owns the board and the socket.
export interface BoardResumeFeed {
  /** Read the board over HTTP. */
  read(): Promise<BoardState>
  /** Adopt a board read over HTTP. False when it no longer belongs to this feed (the page moved on). */
  adopt(state: BoardState): boolean
  /** The boot and seq of the board this feed holds, or null when it holds none it can resume from. */
  held(): { bootId: string; seq: number } | null
  /** Name a (boot, seq) on the live socket. Called only between `hello` and `dropped`. */
  send(bootId: string, seq: number): void
}

// Reads past the second in a row without the socket making progress wait, doubling from this, so a
// server that keeps disagreeing (a boot that changed between the read and the resume, a read that
// fails) costs a read every few seconds rather than one per round trip.
const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 15_000

export class BoardResume {
  private reading = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  // The boot the live socket's hello named; null while there is no live socket to resume on.
  private serverBoot: string | null = null
  // Reads since the socket last made progress (a hello, or a delta applied).
  private reads = 0
  // Bumped by reset(): a read started for what the feed showed before must not land on what it shows now.
  private generation = 0

  constructor(private readonly feed: BoardResumeFeed) {}

  /** Start reading the board now, before the socket opens — the page-load path. */
  prefetch(): void {
    this.read()
  }

  /** A socket said hello: name the board held, or read one first. */
  hello(bootId: string): void {
    this.serverBoot = bootId
    this.reads = 0
    this.resume()
  }

  /** The socket is gone. The board and its seq stay; the next hello resumes from them. */
  dropped(): void {
    this.serverBoot = null
  }

  /** The server cannot resume from the seq named, or a delta skipped one: read the board again. */
  resync(): void {
    this.read()
  }

  /** A delta applied: the socket is delivering, so the next disagreement reads at once. */
  progressed(): void {
    this.reads = 0
  }

  /** Forget what the feed held: a read in flight is discarded, and nothing is named until the next hello. */
  reset(): void {
    this.generation++
    this.reading = false
    this.serverBoot = null
    this.reads = 0
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private resume(): void {
    if (this.serverBoot === null || this.reading || this.retryTimer) return
    const held = this.feed.held()
    // A board from another boot cannot be resumed; asking would only earn a resync.
    if (!held || held.bootId !== this.serverBoot) return this.read()
    this.feed.send(held.bootId, held.seq)
  }

  private read(): void {
    if (this.reading || this.retryTimer) return
    const generation = this.generation
    const delay = this.reads >= 2 ? Math.min(RETRY_BASE_MS * 2 ** (this.reads - 2), RETRY_MAX_MS) : 0
    this.reads++
    const go = (): void => {
      this.retryTimer = null
      this.reading = true
      let failed = false
      this.feed.read().then(
        (state) => {
          if (generation === this.generation) this.feed.adopt(state)
        },
        () => {
          failed = true
        },
      ).finally(() => {
        if (generation !== this.generation) return
        this.reading = false
        if (failed) this.read()
        else this.resume()
      })
    }
    if (delay > 0) this.retryTimer = setTimeout(go, delay)
    else go()
  }
}
