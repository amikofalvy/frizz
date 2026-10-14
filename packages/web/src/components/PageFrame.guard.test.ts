import assert from "node:assert/strict"
import { globSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"

// What a tab does about the server it is talking to — the restart overlay, the page going inert under
// it, the reload onto a new build, the notifications setting mirrored onto the store — is PageFrame's,
// and both page shells stand in it. It was App.tsx's alone until 2026-10-13, so the full-screen thread
// page did none of it: a tab there kept an old bundle running against a new server, and one cold-loaded
// there never raised a notification. If this fails on your change, the thing you are adding belongs in
// PageFrame.tsx, where both shells get it. Fixtures are exempt: a fixture page is its own shell.

const src = fileURLToPath(new URL("../", import.meta.url))
const sources = new Map(
  globSync("**/*.{ts,tsx}", { cwd: src })
    .map((file) => file.split("\\").join("/"))
    .filter((file) => !/\.test\.tsx?$/.test(file) && !/-fixture\.tsx$/.test(file))
    .map((file) => [file, readFileSync(`${src}/${file}`, "utf8")] as const),
)
// A use is the text on a line of code; a comment may name any of these anywhere.
const isComment = (line: string) => /^\s*(?:\/\/|\/?\*|\{\/\*)/.test(line)
const filesWith = (needle: string | RegExp) => [...sources]
  .filter(([, text]) => text.split("\n").some((line) => !isComment(line) && (typeof needle === "string" ? line.includes(needle) : needle.test(line))))
  .map(([file]) => file)
  .sort()

const FRAME = "components/PageFrame.tsx"
const SHELLS = ["App.tsx", "components/StandaloneThreadPage.tsx"]

test("the restart overlay, the reload onto a new build and the notifications mirror are PageFrame's alone", () => {
  assert.deepEqual(filesWith("<RestartOverlay"), [FRAME], "<RestartOverlay is PageFrame's to mount")
  // The mirror: one writer. (`==` and `===` are reads.)
  assert.deepEqual(filesWith(/store\.notificationsEnabled\s*=(?!=)/), [FRAME], "store.notificationsEnabled is PageFrame's to write")
  // The control-plane view is stepped per answer by the frame, and raised optimistically by the button
  // that asks for a restart. A third writer is a second follower.
  assert.deepEqual(filesWith(/store\.controlPlaneState\s*=(?!=)/), [FRAME, "components/RestartFrizzButton.tsx"])
  // The two reloads, each named by the function that decides it.
  assert.deepEqual(filesWith("shouldReloadForNewBuild("), [FRAME, "api/restart.ts"].sort())
  assert.deepEqual(filesWith("sessionStorage.getItem(RELOAD_AFTER_UPDATE_RESTART)"), [FRAME])
})

test("both page shells stand in the frame, once, and wire none of it themselves", () => {
  assert.deepEqual(filesWith("<PageFrame"), SHELLS, "a new shell is added here on purpose")
  for (const file of SHELLS) {
    const text = sources.get(file)!
    assert.equal((text.match(/<PageFrame\b/g) ?? []).length, 1, `${file} stands in one PageFrame`)
    // The frame is the shell's root, so the overlay cannot be mounted without the page going inert
    // under it. A shell that reads the supervisor or the control-plane state for itself has forked it.
    assert.doesNotMatch(text, /useSupervisorStatus\(|controlPlaneState|nextControlPlane\(|nextRestartHold\(/, `${file} follows the supervisor through PageFrame`)
  }
  const frame = sources.get(FRAME)!
  // The overlay is a sibling of the inert root, never inside it: it has to stay interactive.
  assert.match(frame, /<RestartOverlay[\s\S]*?\/>[\s\S]*?<div inert=\{blocking\} className=\{className\} style=\{style\}>\s*\{children\}\s*<\/div>/)
  // One fact drives both halves of the block: the page is inert, and deaf to Escape, exactly while the
  // overlay blocks, and neither once the hold has stalled.
  assert.match(frame, /const blocking = restarting && !hold\.stalled\n\s*useEscapeSwallowed\(blocking\)/)
})
