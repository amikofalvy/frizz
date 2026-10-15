import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { WORKER_PLUGIN_SIBLINGS, defaultPluginStageRoot, defaultStablePluginRoot, ensureSymlink, pluginContentDigest, pluginFingerprint, stageStablePluginDir } from "./stable-plugin-path.ts"

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

/** A minimal plugin tree: a hooks.json plus the script it names, so a half-staged copy is detectable. */
function plugin(root: string, marker: string): string {
  const dir = join(root, "cc-worker")
  mkdirSync(join(dir, "hooks"), { recursive: true })
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: { Stop: marker } }))
  writeFileSync(join(dir, "hooks", "stop.mjs"), `// ${marker}\n`)
  return dir
}

// ---- ensureSymlink: the four cases, stated one at a time ----------------------------------------

test("ensureSymlink creates a missing link, and is a no-op when it is already correct", () => {
  const dir = tmp("frizz-symlink-")
  const target = join(dir, "target")
  mkdirSync(target)
  const link = join(dir, "nested", "current")

  assert.equal(ensureSymlink(link, target), "created", "a missing link is created, parents included")
  assert.equal(readlinkSync(link), target)
  assert.equal(ensureSymlink(link, target), "unchanged", "the same call again must not churn the link")
})

test("ensureSymlink repoints a link aimed elsewhere — the case the whole design rests on", () => {
  const dir = tmp("frizz-symlink-")
  const a = join(dir, "buildA")
  const b = join(dir, "buildB")
  mkdirSync(a); mkdirSync(b)
  const link = join(dir, "current")

  ensureSymlink(link, a)
  assert.equal(ensureSymlink(link, b), "repointed")
  assert.equal(readlinkSync(link), b, "a live worker following this path now sees buildB")
})

// A RELATIVE existing link resolves against the link's own directory, never the process cwd. Compare
// them naively and every call looks stale, so the link is deleted and recreated forever.
test("ensureSymlink resolves an existing RELATIVE link against its own directory", () => {
  const dir = tmp("frizz-symlink-")
  const target = join(dir, "target")
  mkdirSync(target)
  const link = join(dir, "current")
  symlinkSync("./target", link)
  // Read it BACK rather than pinning the literal: Windows stores a reparse point in its own
  // separator, so the link created from "./target" reads as ".\target" there. Comparing against
  // what the link actually holds is what "left exactly as it was" means on either platform.
  const before = readlinkSync(link)
  assert.ok(!isAbsolute(before), "the fixture link is relative — that is the whole case under test")

  assert.equal(ensureSymlink(link, target), "unchanged", "./target IS this target — do not churn it")
  assert.equal(readlinkSync(link), before, "and the existing relative link is left exactly as it was")
})

// Silently deleting a real directory someone else put at the stable path is data loss, not recovery.
test("ensureSymlink refuses to replace a real file or directory", () => {
  const dir = tmp("frizz-symlink-")
  const target = join(dir, "target")
  mkdirSync(target)

  const asDir = join(dir, "occupied-dir")
  mkdirSync(asDir)
  assert.throws(() => ensureSymlink(asDir, target), /not a symlink/)
  assert.ok(lstatSync(asDir).isDirectory(), "the directory it refused to replace is still there")

  const asFile = join(dir, "occupied-file")
  writeFileSync(asFile, "mine")
  assert.throws(() => ensureSymlink(asFile, target), /not a symlink/)
  assert.equal(readFileSync(asFile, "utf8"), "mine")
})

// ---- staging -------------------------------------------------------------------------------------

test("stageStablePluginDir copies the plugin under its version and publishes the stable path", () => {
  const dir = tmp("frizz-stage-")
  const source = plugin(join(dir, "src"), "v1")
  const home = join(dir, "home")

  const result = stageStablePluginDir({ source, version: "0.1.1", home })

  assert.equal(result.stagedPath, join(defaultPluginStageRoot(home), "0.1.1", "cc-worker"))
  assert.equal(result.stablePath, join(defaultStablePluginRoot(home), "cc-worker"))
  assert.equal(result.outcome, "created")
  // The stable path must serve the plugin's CONTENT, since that is what a worker loads through it.
  assert.match(readFileSync(join(result.stablePath, "hooks", "hooks.json"), "utf8"), /v1/)
  assert.ok(existsSync(join(result.stablePath, "hooks", "stop.mjs")), "the script hooks.json names came too")
})

// The whole point: a worker launched against the stable path can be moved onto a DIFFERENT immutable
// build without touching either build, which is what makes a live reloadPlugins() meaningful.
test("staging a second version repoints the stable path without disturbing the first", () => {
  const dir = tmp("frizz-stage-")
  const home = join(dir, "home")
  const first = stageStablePluginDir({ source: plugin(join(dir, "a"), "old"), version: "0.1.1", home })
  const second = stageStablePluginDir({ source: plugin(join(dir, "b"), "new"), version: "0.1.2", home })

  assert.equal(second.outcome, "repointed")
  assert.equal(first.stablePath, second.stablePath, "the path a worker holds never changes")
  assert.match(readFileSync(join(second.stablePath, "hooks", "hooks.json"), "utf8"), /new/)
  assert.match(readFileSync(join(first.stagedPath, "hooks", "hooks.json"), "utf8"), /old/,
    "the previous version stays staged — a worker still on it keeps working")
})

test("re-staging the same version is idempotent and leaves the link alone", () => {
  const dir = tmp("frizz-stage-")
  const home = join(dir, "home")
  const source = plugin(join(dir, "src"), "v1")

  const once = stageStablePluginDir({ source, version: "0.1.1", home })
  const twice = stageStablePluginDir({ source, version: "0.1.1", home })
  assert.equal(once.outcome, "created")
  assert.equal(twice.outcome, "unchanged", "a boot-time call must not churn a path live workers follow")
})

// Staging leaves no temp directory behind, so a crashed stage cannot masquerade as a staged version.
test("staging leaves no pending scratch behind", () => {
  const dir = tmp("frizz-stage-")
  const home = join(dir, "home")
  stageStablePluginDir({ source: plugin(join(dir, "src"), "v1"), version: "0.1.1", home })
  assert.deepEqual(readdirSync(defaultPluginStageRoot(home)).sort(), ["0.1.1"], "only the version directory survives")
})

// A sibling the plugin imports from is staged beside it, so `../../../board/x.mjs` from a staged shim
// lands on the staged board. A version staged by a server that predates siblings has the plugin alone,
// and must be completed rather than accepted as staged.
test("staging carries the plugin's siblings, and completes a version staged without them", () => {
  const dir = tmp("frizz-stage-")
  const home = join(dir, "home")
  const source = plugin(join(dir, "src"), "v1")
  mkdirSync(join(dir, "src", "board"))
  writeFileSync(join(dir, "src", "board", "config.mjs"), "export const board = 1\n")

  const old = stageStablePluginDir({ source, version: "0.1.1", home })
  assert.ok(!existsSync(join(dirname(old.stagedPath), "board")), "the fixture: a version staged with no siblings")

  const result = stageStablePluginDir({ source, version: "0.1.1", home, siblings: ["board"] })
  assert.equal(readFileSync(join(dirname(result.stagedPath), "board", "config.mjs"), "utf8"), "export const board = 1\n")
  assert.deepEqual(readdirSync(defaultPluginStageRoot(home)).sort(), ["0.1.1"], "and no pending scratch survives")
})

// The version becomes a directory name under the user's home; it is never allowed to escape it.
test("stageStablePluginDir rejects a version that could escape the stage root", () => {
  const dir = tmp("frizz-stage-")
  const source = plugin(join(dir, "src"), "v1")
  const home = join(dir, "home")
  for (const bad of ["../escape", "a/b", "", ".hidden", "x".repeat(200)]) {
    assert.throws(() => stageStablePluginDir({ source, version: bad, home }), /unsafe plugin version/, `accepted ${JSON.stringify(bad)}`)
  }
})

// A repoint swaps the link by rename, so a hook a live worker runs through it never finds it missing.
// The swap itself cannot be observed from here; what can is that it leaves nothing beside the link.
test("repointing leaves no scratch link beside the stable path", () => {
  const dir = tmp("frizz-symlink-")
  const a = join(dir, "buildA")
  const b = join(dir, "buildB")
  mkdirSync(a); mkdirSync(b)
  const links = join(dir, "current")
  ensureSymlink(join(links, "cc-worker"), a)
  ensureSymlink(join(links, "cc-worker"), b)
  assert.deepEqual(readdirSync(links), ["cc-worker"])
})

// ---- identity: what a version is staged under, and what a running worker compares ----------------

test("pluginContentDigest is the content's identity: same bytes, same digest, wherever they sit", () => {
  const dir = tmp("frizz-digest-")
  const one = plugin(join(dir, "one"), "v1")
  const two = plugin(join(dir, "two"), "v1")
  assert.equal(pluginContentDigest(one), pluginContentDigest(two))
  assert.match(pluginContentDigest(one), /^[0-9a-f]{16}$/, "and it is safe to use as a staged version directory")

  writeFileSync(join(two, "hooks", "stop.mjs"), "// v2\n")
  assert.notEqual(pluginContentDigest(one), pluginContentDigest(two), "an edited script is a different plugin")

  const renamed = plugin(join(dir, "three"), "v1")
  renameSync(join(renamed, "hooks", "stop.mjs"), join(renamed, "hooks", "halt.mjs"))
  assert.notEqual(pluginContentDigest(one), pluginContentDigest(renamed), "and so is the same bytes under another name")

  mkdirSync(join(dir, "one", "board"))
  writeFileSync(join(dir, "one", "board", "config.mjs"), "// a\n")
  const withBoard = pluginContentDigest(one, ["board"])
  assert.notEqual(withBoard, pluginContentDigest(one), "a sibling staged with the plugin is part of its identity")
  writeFileSync(join(dir, "one", "board", "config.mjs"), "// b\n")
  assert.notEqual(pluginContentDigest(one, ["board"]), withBoard, "so an edit to the sibling is a different plugin")
})

// The two ways a running worker's plugin moves, and the fingerprint has to see both.
test("pluginFingerprint moves when the stable path is repointed, even at identical content", () => {
  const dir = tmp("frizz-fingerprint-")
  const home = join(dir, "home")
  const first = stageStablePluginDir({ source: plugin(join(dir, "a"), "same"), version: "one", home })
  const before = pluginFingerprint(first.stablePath)
  assert.ok(before)
  assert.equal(pluginFingerprint(first.stablePath), before, "asking twice changes nothing")

  stageStablePluginDir({ source: plugin(join(dir, "b"), "same"), version: "two", home })
  assert.notEqual(pluginFingerprint(first.stablePath), before)
})

test("pluginFingerprint moves when a checkout's plugin is edited in place", () => {
  const dir = tmp("frizz-fingerprint-")
  const checkout = plugin(dir, "v1")
  const before = pluginFingerprint(checkout)
  writeFileSync(join(checkout, "hooks", "stop.mjs"), "// edited, and a different length\n")
  assert.notEqual(pluginFingerprint(checkout), before, "an edited file")
  const edited = pluginFingerprint(checkout)
  mkdirSync(join(checkout, "skills", "new"), { recursive: true })
  writeFileSync(join(checkout, "skills", "new", "SKILL.md"), "---\nname: new\n---\n")
  assert.notEqual(pluginFingerprint(checkout), edited, "an added file")
})

test("pluginFingerprint is undefined for a plugin that cannot be read", () => {
  assert.equal(pluginFingerprint(join(tmp("frizz-fingerprint-"), "gone")), undefined)
})

// ---- the real plugin, staged ---------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url))

/** Every relative import reachable from the plugin's own files, followed into whatever they reach. */
function unresolvedImports(pluginDir: string): string[] {
  const queue: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(mjs|cjs|js)$/.test(name)) queue.push(path)
    }
  }
  walk(pluginDir)
  const seen = new Set<string>()
  const missing: string[] = []
  for (let file = queue.shift(); file; file = queue.shift()) {
    if (seen.has(file)) continue
    seen.add(file)
    for (const [, spec] of readFileSync(file, "utf8").matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.\.?\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), spec!)
      if (existsSync(target)) queue.push(target)
      else missing.push(`${file.slice(pluginDir.length)} imports ${spec}`)
    }
  }
  return missing
}

// The hooks that import the board through `scripts/frizz/*.mjs`. Run without FRIZZ_THREAD, each is
// inert and exits 0 — once its imports have loaded, which is the part under test.
const BOARD_HOOKS: Array<[string, string[]]> = [
  ["session-seed.mjs", []],
  ["scratchpad.mjs", ["--mode=nudge", "--event=PostToolUse"]],
  ["agent-bind.mjs", []],
]

function runHook(pluginDir: string, hook: string, args: string[], home: string) {
  return spawnSync(process.execPath, [join(pluginDir, "hooks", hook), ...args], {
    input: "{}",
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: home, CLAUDE_PROJECT_DIR: home },
  })
}

// The bug this pins ran from 2026-10-11 to 2026-10-15: the staged copy held cc-worker alone, so every
// hook that reaches the board died on its first import in every worker, and Claude reported each
// failure as non-blocking.
test("the real worker plugin, staged, loads everything it imports", () => {
  const dir = tmp("frizz-stage-real-")
  const home = join(dir, "home")
  mkdirSync(home)
  const source = join(repoRoot, "cc-worker")
  const version = pluginContentDigest(source, WORKER_PLUGIN_SIBLINGS)

  const { stablePath, stagedPath } = stageStablePluginDir({ source, version, siblings: WORKER_PLUGIN_SIBLINGS, home })
  assert.deepEqual(unresolvedImports(stagedPath), [], "a relative import leaves the plugin for a directory WORKER_PLUGIN_SIBLINGS does not name")
  for (const [hook, args] of BOARD_HOOKS) {
    const result = runHook(stablePath, hook, args, home)
    assert.equal(result.status, 0, `${hook}: ${result.stderr}`)
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/, hook)
  }

  // The negative control: the same plugin staged without its siblings is the copy workers were given.
  const bare = stageStablePluginDir({ source, version: `${version}-bare`, home: join(dir, "bare-home") })
  assert.notDeepEqual(unresolvedImports(bare.stagedPath), [])
  assert.match(runHook(bare.stagedPath, "agent-bind.mjs", [], home).stderr, /ERR_MODULE_NOT_FOUND/)
  rmSync(dir, { recursive: true, force: true })
})
