// A `status: watching` PARK THAT NOTHING WILL WAKE GOES TO THE QUEUE (maintainer 2026-10-25: "The snoozed items
// are often frozen waiting for something that will never happen"). Of fourteen Snoozed threads in one project,
// five were PR parks with green CI and only the maintainer's merge left, two were PR parks on red CI their
// workers had chosen not to fix, and three were timer loops polling another thread for a grant that never came.
// The rule (board parkStall): a PR park whose every PR waits on this side, or four quiet parks over a day with
// no human message between them, is not honoured as a park. Driven through the real fold (both backends' paths)
// and the real board.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isSnoozed, wakeDeliveryToken, type GithubWatchStatus } from "@frizz/shared"
import { GITHUB_STATUS_SETTING } from "./awaiting.ts"
import { Bus } from "./bus.ts"
import { createBoard } from "./board.ts"
import type { Project } from "./project.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { applyEvent, applyRecord, newTailState, type SessionTelemetry, type Tailer } from "./tailer.ts"

const T0 = Date.now() + 7 * 86_400_000
const HOUR = 60
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString()
const PR = "inkeep/agents-private#7438"
const PR_PARK = "```awaiting\nprs: [inkeep/agents-private#7438]\nstatus: watching\nfor: 180d\n```"
const TIMER_PARK = "```awaiting\ntimers: [tmr_poll]\nstatus: watching\nfor: 1d\n```"
const WORKING = "```awaiting\ntimers: [tmr_poll]\nstatus: working\nfor: 1d\n```"
const READY: GithubWatchStatus = {
  checks: "passing", running: 0, passed: 85, failed: 0, skipped: 30, gated: 0, gating: [], failing: [],
  merge: "mergeable", state: "open", polledAt: at(0), mergePath: "none", viewerAuthored: true, viewerCanMerge: true,
}
const RED: GithubWatchStatus = { ...READY, checks: "failing", passed: 80, failed: 2, failing: ["lint"], merge: "blocked" }

function world(backend: "claude" | "codex", github: GithubWatchStatus) {
  const slug = "t"
  const dir = mkdtempSync(join(tmpdir(), "frizz-stalled-park-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.upsertSession({
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: at(-60),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  storage.setBackend(slug, backend)
  if (backend === "claude") storage.setClaudeRuntime(slug, "broker")
  else storage.setCodexRuntime(slug, "app-server")
  storage.armPrWatch({ id: "prw_1", slug, owner: "inkeep", repo: "agents-private", number: 7438, createdAtMs: Date.parse(at(0)), expiresAtMs: Date.parse(at(0)) + 180 * 86_400_000 })
  storage.armThreadTimer({ id: "tmr_poll", slug, prompt: "check whether root granted the next step", fireAtMs: Date.parse(at(100 * HOUR)), createdAtMs: Date.parse(at(0)) })
  storage.setSetting(GITHUB_STATUS_SETTING, { [PR]: github })
  const s = newTailState(slug, `sid-${slug}`, "/dev/null")
  const tele = (): SessionTelemetry => ({
    turn: "idle", permPrompt: false, subAgents: [], bgShells: [], retiredShells: [], retiredSubAgents: [], pendingQuestion: false,
    lastActivityAt: s.lastActivityAt, lastAssistantAt: s.lastAssistantAt, lastAssistant: s.lastAssistant, lastAssistantLine: s.lastAssistantLine,
    lastUserAt: s.lastUserAt, restFromAt: s.restFromAt, handoffAt: s.handoffAt, parkStreak: s.parkStreak, lastUserText: s.lastUserText, lastFence: s.lastFence,
  } as SessionTelemetry)
  const tailer = {
    get: (x: string) => (x === slug ? tele() : undefined), foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  } as unknown as Tailer
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  let nowMs = Date.parse(at(1))
  const board = createBoard(project, storage, new Bus(), tailer, "stalled-park", { claudeBrokerDaemonAlive: () => true, now: () => nowMs })
  const say = backend === "claude"
    ? (minute: number, text: string) => applyRecord(s, { type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } } as never)
    : (minute: number, text: string) => {
        applyEvent(s, { kind: "assistant-text", at: at(minute), text, final: true })
        applyEvent(s, { kind: "turn-end", at: at(minute), finalText: text })
      }
  const user = backend === "claude"
    ? (minute: number, text: string) => applyRecord(s, { type: "user", timestamp: at(minute), message: { role: "user", content: text } } as never)
    : (minute: number, text: string) => {
        applyEvent(s, { kind: "user-message", at: at(minute), text, synthetic: false })
        applyEvent(s, { kind: "turn-start", at: at(minute) })
      }
  // One polling cycle as the worker lives it: the timer's wake, a line of narration, the re-park.
  const poll = (minute: number) => {
    user(minute, `⏰ check whether root granted the next step\n\n${wakeDeliveryToken(`wake-${minute}`)}`)
    say(minute + 1, "No new grant from root. Re-arming the fallback timer.")
    say(minute + 2, TIMER_PARK)
  }
  return {
    say, user, poll, storage,
    setNow: (minute: number) => { nowMs = Date.parse(at(minute)) },
    view: () => board.refresh().threads.find((x) => x.id === slug)!,
    close: () => { board.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

function assertSnoozedWatch(v: ReturnType<ReturnType<typeof world>["view"]>, why: string) {
  assert.equal(v.needsYou, false, why)
  assert.equal(v.waitStatus, "watching", why)
  assert.equal(v.stalledPark, undefined, why)
  assert.equal(isSnoozed(v), true, why)
}

for (const backend of ["claude", "codex"] as const) {
  test(`${backend}: a PR park waiting only on our own merge queues, naming the PR`, () => {
    const w = world(backend, READY)
    try {
      w.user(0, "own inkeep/agents-private#7438")
      w.say(1, PR_PARK)
      const v = w.view()
      assert.equal(v.needsYou, true)
      assert.equal(isSnoozed(v), false)
      assert.deepEqual(v.stalledPark, { why: "pr-idle", refs: [PR] })
    } finally { w.close() }
  })

  test(`${backend}: a PR park on red CI of our own PR queues; someone else's red PR stays a wait`, () => {
    const ours = world(backend, RED)
    const theirs = world(backend, { ...RED, viewerAuthored: false })
    try {
      for (const w of [ours, theirs]) {
        w.user(0, "watch inkeep/agents-private#7438")
        w.say(1, PR_PARK)
      }
      assert.deepEqual(ours.view().stalledPark, { why: "pr-idle", refs: [PR] })
      assert.equal(ours.view().needsYou, true)
      assertSnoozedWatch(theirs.view(), "the author will push the fix")
    } finally { ours.close(); theirs.close() }
  })

  test(`${backend}: a PR park that someone or something else will move stays snoozed`, () => {
    const cases: [GithubWatchStatus, string][] = [
      [{ ...READY, viewerCanMerge: false }, "a maintainer of someone else's repo merges it"],
      [{ ...READY, mergePath: "auto" }, "auto-merge lands it"],
      [{ ...READY, mergePath: "queued" }, "the merge queue lands it"],
      [{ ...READY, checks: "running", running: 3, passed: 82 }, "CI is still running"],
      [{ ...READY, merge: "blocked" }, "a required review is outstanding"],
      [{ checks: "passing", running: 0, passed: 85, failed: 0, skipped: 30, gated: 0, gating: [], failing: [], merge: "mergeable", state: "open", polledAt: at(0) }, "a reading that does not say who it waits on"],
    ]
    for (const [status, why] of cases) {
      const w = world(backend, status)
      try {
        w.user(0, "own inkeep/agents-private#7438")
        w.say(1, PR_PARK)
        const v = w.view()
        assert.equal(v.needsYou, false, why)
        assert.equal(v.stalledPark, undefined, why)
      } finally { w.close() }
    }
  })

  test(`${backend}: four quiet parks over a day with no human message queue as repeated`, () => {
    const w = world(backend, READY)
    try {
      w.user(0, "wait for root's grant before running anything")
      w.say(1, TIMER_PARK)
      w.poll(12 * HOUR)
      w.poll(24 * HOUR)
      w.setNow(24 * HOUR + 5)
      assertSnoozedWatch(w.view(), "three parks is still a wait")
      w.poll(36 * HOUR)
      w.setNow(36 * HOUR + 5)
      const v = w.view()
      assert.equal(v.needsYou, true)
      assert.equal(isSnoozed(v), false)
      assert.deepEqual(v.stalledPark, { why: "repeated", parks: 4, since: at(1) })
    } finally { w.close() }
  })

  test(`${backend}: four quick parks inside a day stay a wait`, () => {
    const w = world(backend, READY)
    try {
      w.user(0, "wait for root's grant")
      w.say(1, TIMER_PARK)
      for (const hour of [2, 4, 6]) w.poll(hour * HOUR)
      w.setNow(6 * HOUR + 5)
      assertSnoozedWatch(w.view(), "the run has not lasted a day")
    } finally { w.close() }
  })

  test(`${backend}: a human message, or any other kind of rest, starts the count again`, () => {
    const typed = world(backend, READY)
    const handed = world(backend, READY)
    try {
      for (const w of [typed, handed]) {
        w.user(0, "wait for root's grant")
        w.say(1, TIMER_PARK)
        w.poll(12 * HOUR)
        w.poll(24 * HOUR)
      }
      typed.user(30 * HOUR, "keep waiting, root is busy today")
      typed.say(30 * HOUR + 1, TIMER_PARK)
      handed.user(30 * HOUR, `⏰ check whether root granted the next step\n\n${wakeDeliveryToken("wake-granted")}`)
      handed.say(30 * HOUR + 1, WORKING)
      for (const w of [typed, handed]) {
        w.poll(42 * HOUR)
        w.setNow(42 * HOUR + 5)
        assertSnoozedWatch(w.view(), "the run restarted")
      }
    } finally { typed.close(); handed.close() }
  })
}
