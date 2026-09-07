import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  PRODUCTION_REEXEC_FLAG,
  handoffToRegistrySuccessor,
  installedBinEntry,
  npmRegistryReleaseAdapter,
  planRegistryUpdate,
  prepareRegistrySuccessor,
  pruneReleases,
  resolveNpmInvocation,
  type RegistryReleaseAdapter,
  type RegistryUpdatePlan,
} from "./production-update.ts";

const execFileP = promisify(execFile);

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { unrefCalls: number; unref(): void };
  child.unrefCalls = 0;
  child.unref = () => { child.unrefCalls++; };
  return child;
}

const plan: RegistryUpdatePlan = { packageName: "frizz", currentVersion: "1.2.3", latestVersion: "1.3.0", packageSpec: "frizz@1.3.0" };

test("registry update does nothing when the installed version is current", async () => {
  assert.equal(await planRegistryUpdate("frizz", "1.2.3", { latestVersion: async () => "1.2.3" }), null);
});

test("registry update selects an immutable newer package spec", async () => {
  assert.deepEqual(await planRegistryUpdate("frizz", "1.2.3", { latestVersion: async () => "1.3.0" }), plan);
});

test("registry lookup failure leaves the healthy process untouched", async () => {
  await assert.rejects(() => planRegistryUpdate("frizz", "1.2.3", { latestVersion: async () => { throw new Error("offline"); } }), /offline/);
});

test("npm runs as node + npm-cli.js — the bare `npm` name is only a `.cmd` shim on Windows", () => {
  const node = join("/", "opt", "node", "bin", "node");
  const cli = join("/", "opt", "node", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const exists = (path: string) => path === cli;
  const rows: Array<{ name: string; env: NodeJS.ProcessEnv; execPath: string; exists: (path: string) => boolean; expected: ReturnType<typeof resolveNpmInvocation> }> = [
    { name: "npm_execpath names npm-cli.js", env: { npm_execpath: cli }, execPath: node, exists, expected: { command: node, prefixArgs: [cli] } },
    { name: "an npx-cli.js hint resolves to the sibling npm-cli.js", env: { npm_execpath: join("/", "opt", "node", "lib", "node_modules", "npm", "bin", "npx-cli.js") }, execPath: node, exists, expected: { command: node, prefixArgs: [cli] } },
    { name: "a pnpm hint has no npm-cli.js beside it", env: { npm_execpath: join("/", "opt", "pnpm", "bin", "pnpm.cjs") }, execPath: node, exists, expected: { command: node, prefixArgs: [cli] } },
    { name: "no hint: the npm that ships with node (POSIX layout)", env: {}, execPath: node, exists, expected: { command: node, prefixArgs: [cli] } },
    { name: "a stale hint that points nowhere is skipped", env: { npm_execpath: join("/", "gone", "npm-cli.js") }, execPath: node, exists, expected: { command: node, prefixArgs: [cli] } },
  ];
  const windowsNode = join("C:", "Program Files", "nodejs", "node.exe");
  const windowsCli = join("C:", "Program Files", "nodejs", "node_modules", "npm", "bin", "npm-cli.js");
  rows.push({ name: "no hint: the npm beside node.exe (Windows layout)", env: {}, execPath: windowsNode, exists: (path) => path === windowsCli, expected: { command: windowsNode, prefixArgs: [windowsCli] } });
  for (const row of rows) assert.deepEqual(resolveNpmInvocation(row.env, row.execPath, row.exists, "linux"), row.expected, row.name);
  // No script at all: POSIX keeps the bare command, Windows refuses (the bare name is a dead spawn there).
  assert.deepEqual(resolveNpmInvocation({}, node, () => false, "linux"), { command: "npm", prefixArgs: [] });
  assert.throws(() => resolveNpmInvocation({}, windowsNode, () => false, "win32"), /npm-cli\.js not found beside/);
});

test("the resolved npm invocation actually starts on this platform", async () => {
  // Pins the spawn, not the registry: before this, Windows failed with `spawn npm ENOENT` because the
  // bare name only reaches a `.cmd` shim there. `--version` is the cheapest thing npm answers offline.
  const npm = resolveNpmInvocation();
  const { stdout } = await execFileP(npm.command, [...npm.prefixArgs, "--version"], { encoding: "utf8" });
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/u);
});

test("Windows installs the release into a private directory before the handoff; POSIX does not", async () => {
  const installs: Array<{ packageName: string; packageSpec: string; releaseDir: string }> = [];
  const adapter: Pick<RegistryReleaseAdapter, "installRelease"> = {
    installRelease: async (request) => { installs.push(request); return join(request.releaseDir, "node_modules", "frizz", "dist", "frizz.js"); },
  };
  const releasesDir = join("/", "home", "op", ".frizz", "releases");
  const prepared = await prepareRegistrySuccessor(plan, adapter, { platform: "win32", releasesDir });
  assert.deepEqual(installs, [{ packageName: "frizz", packageSpec: "frizz@1.3.0", releaseDir: join(releasesDir, "frizz-1.3.0") }]);
  assert.equal(prepared.entry, join(releasesDir, "frizz-1.3.0", "node_modules", "frizz", "dist", "frizz.js"));
  // Preparing twice (updateRestart, then durableReexec) installs once.
  assert.equal(await prepareRegistrySuccessor(prepared, adapter, { platform: "win32", releasesDir }), prepared);
  assert.equal(installs.length, 1);
  assert.equal(await prepareRegistrySuccessor(plan, adapter, { platform: "linux", releasesDir }), plan);
  assert.equal(installs.length, 1);
});

test("a successful Windows install prunes every other release except the running one", async () => {
  const releasesDir = mkdtempSync(join(tmpdir(), "frizz-releases-"));
  try {
    for (const name of ["frizz-0.9.0", "frizz-1.1.0", "frizz-1.2.3", "other-1.0.0"]) mkdirSync(join(releasesDir, name));
    writeFileSync(join(releasesDir, "frizz-notes.txt"), "not a release");
    const adapter: Pick<RegistryReleaseAdapter, "installRelease"> = {
      installRelease: async ({ releaseDir }) => { mkdirSync(releaseDir, { recursive: true }); return join(releaseDir, "node_modules", "frizz", "dist", "frizz.js"); },
    };
    await prepareRegistrySuccessor(plan, adapter, { platform: "win32", releasesDir });
    const kept = ["frizz-1.2.3", "frizz-1.3.0", "other-1.0.0", "frizz-notes.txt"].filter((name) => existsSync(join(releasesDir, name)));
    assert.deepEqual(kept, ["frizz-1.2.3", "frizz-1.3.0", "other-1.0.0", "frizz-notes.txt"], "the running version, the target, and foreign names stay");
    assert.equal(existsSync(join(releasesDir, "frizz-0.9.0")), false);
    assert.equal(existsSync(join(releasesDir, "frizz-1.1.0")), false);
  } finally {
    rmSync(releasesDir, { recursive: true, force: true });
  }
});

test("a failed install prunes nothing, and a failed prune does not fail the update", async () => {
  const releasesDir = mkdtempSync(join(tmpdir(), "frizz-releases-"));
  try {
    mkdirSync(join(releasesDir, "frizz-1.1.0"));
    await assert.rejects(() => prepareRegistrySuccessor(plan, { installRelease: async () => { throw new Error("registry down"); } }, { platform: "win32", releasesDir }), /registry down/);
    assert.equal(existsSync(join(releasesDir, "frizz-1.1.0")), true, "the last good release survives a failed install");
    const entry = join(releasesDir, "frizz-1.3.0", "node_modules", "frizz", "dist", "frizz.js");
    const fs = { readdirSync, rmSync: () => { throw new Error("EBUSY: a stale release still holds a file open"); } } as unknown as Parameters<typeof pruneReleases>[3];
    const prepared = await prepareRegistrySuccessor(plan, { installRelease: async () => entry }, { platform: "win32", releasesDir, fs });
    assert.equal(prepared.entry, entry);
  } finally {
    rmSync(releasesDir, { recursive: true, force: true });
  }
});

test("pruneReleases reports what it removed and skips files and other packages", () => {
  const removed: string[] = [];
  const dirent = (name: string, directory = true) => ({ name, isDirectory: () => directory });
  const fs = {
    readdirSync: () => [dirent("frizz-1.0.0"), dirent("frizz-1.2.3"), dirent("frizz-1.3.0"), dirent("frizz-2.0.0-beta.1"), dirent("frizz-old.log", false), dirent("frizzy-1.0.0"), dirent("other-1.0.0")],
    rmSync: (path: string) => { removed.push(path); },
  } as unknown as Parameters<typeof pruneReleases>[3];
  const releasesDir = join("/", "home", "op", ".frizz", "releases");
  assert.deepEqual(pruneReleases(releasesDir, "frizz", ["1.2.3", "1.3.0"], fs), ["frizz-1.0.0", "frizz-2.0.0-beta.1"]);
  assert.deepEqual(removed, [join(releasesDir, "frizz-1.0.0"), join(releasesDir, "frizz-2.0.0-beta.1")]);
});

test("the bin entry comes from the installed manifest", () => {
  const releaseDir = resolve(join("/", "releases", "frizz-1.3.0"));
  const manifestPath = join(releaseDir, "node_modules", "frizz", "package.json");
  const read = (bin: unknown) => (path: string) => { assert.equal(path, manifestPath); return JSON.stringify({ version: "1.3.0", bin }); };
  assert.equal(installedBinEntry("frizz", releaseDir, read({ frizz: "./dist/frizz.js" })), join(releaseDir, "node_modules", "frizz", "dist", "frizz.js"));
  assert.equal(installedBinEntry("frizz", releaseDir, read("dist/frizz.js")), join(releaseDir, "node_modules", "frizz", "dist", "frizz.js"));
  assert.throws(() => installedBinEntry("frizz", releaseDir, read({ other: "./x.js" })), /no bin named frizz/);
});

test("successor handoff uses npm exec rather than replacing the active npx cache", () => {
  const child = fakeChild();
  let captured: Parameters<RegistryReleaseAdapter["spawnNpmExec"]>[0] | undefined;
  handoffToRegistrySuccessor(
    plan,
    { port: 4917, cwd: "/repo", env: { FRIZZ_LAUNCH_OWNER_TOKEN: "lease" } },
    { spawnNpmExec: (request) => { captured = request; return child as never; }, spawnEntry: () => { throw new Error("no entry was prepared"); } },
  );
  // No project path: the launcher rejects positionals, and the successor reads its project from the env.
  assert.deepEqual(captured?.args, [PRODUCTION_REEXEC_FLAG, "--port", "4917"]);
  assert.equal(captured?.cwd, "/repo");
  assert.equal(captured?.packageSpec, "frizz@1.3.0");
  // The invoked bin tracks the package name so a renamed release (e.g. frizz) can't invoke a stale bin.
  assert.equal(captured?.bin, "frizz");
  assert.equal(captured?.env.FRIZZ_LAUNCH_OWNER_TOKEN, "lease");
  assert.equal(captured?.env.FRIZZ_REGISTRY_VERSION, "1.3.0");
  assert.equal(child.unrefCalls, 1);
});

test("a prepared plan hands off to node + the installed bin, never through npm exec", () => {
  const child = fakeChild();
  let captured: Parameters<RegistryReleaseAdapter["spawnEntry"]>[0] | undefined;
  const entry = join("/", "home", "op", ".frizz", "releases", "frizz-1.3.0", "node_modules", "frizz", "dist", "frizz.js");
  handoffToRegistrySuccessor(
    { ...plan, entry },
    { port: 4917, cwd: "/repo", env: { FRIZZ_LAUNCH_OWNER_TOKEN: "lease" } },
    { spawnEntry: (request) => { captured = request; return child as never; }, spawnNpmExec: () => { throw new Error("npm exec runs the bin through cmd.exe on Windows"); } },
  );
  assert.equal(captured?.entry, entry);
  // No project path: the launcher rejects positionals, and the successor reads its project from the env.
  assert.deepEqual(captured?.args, [PRODUCTION_REEXEC_FLAG, "--port", "4917"]);
  assert.equal(captured?.cwd, "/repo");
  assert.equal(captured?.env.FRIZZ_LAUNCH_OWNER_TOKEN, "lease");
  assert.equal(captured?.env.FRIZZ_REGISTRY_PACKAGE, "frizz");
  assert.equal(captured?.env.FRIZZ_REGISTRY_VERSION, "1.3.0");
  assert.equal(child.unrefCalls, 1);
});

test("the real spawnEntry starts a detached node script that outlives the call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-spawn-entry-"));
  try {
    const marker = join(dir, "started");
    const entry = join(dir, "entry.cjs");
    writeFileSync(entry, `require("node:fs").writeFileSync(process.argv[process.argv.length - 1], process.argv.slice(2).join(" "));`);
    // cwd is the system temp dir, not `dir`: Windows refuses to remove a directory that is still a
    // live process's working directory, and the child may outlive the assertion by a few ms.
    const child = npmRegistryReleaseAdapter.spawnEntry({ entry, args: ["--port", "1", marker], cwd: tmpdir(), env: process.env });
    child.unref();
    // Poll until the marker holds the full text: a read can land between the child's create and its
    // write, so a short or missing file is "not yet", and only the deadline is a failure.
    const expected = `--port 1 ${marker}`;
    const deadline = Date.now() + 10_000;
    let seen = "";
    while (Date.now() < deadline) {
      try { seen = readFileSync(marker, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (seen === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(seen, expected, "the spawned entry never wrote its marker");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
