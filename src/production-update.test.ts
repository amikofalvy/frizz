import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { join } from "node:path";
import {
  PRODUCTION_REEXEC_FLAG,
  handoffToRegistrySuccessor,
  planRegistryUpdate,
  resolveNpmInvocation,
  type RegistryReleaseAdapter,
} from "./production-update.ts";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { unrefCalls: number; unref(): void };
  child.unrefCalls = 0;
  child.unref = () => { child.unrefCalls++; };
  return child;
}

test("registry update does nothing when the installed version is current", async () => {
  assert.equal(await planRegistryUpdate("frizz", "1.2.3", { latestVersion: async () => "1.2.3" }), null);
});

test("registry update selects an immutable newer package spec", async () => {
  assert.deepEqual(await planRegistryUpdate("frizz", "1.2.3", { latestVersion: async () => "1.3.0" }), {
    packageName: "frizz", currentVersion: "1.2.3", latestVersion: "1.3.0", packageSpec: "frizz@1.3.0",
  });
});

test("registry lookup failure leaves the healthy process untouched", async () => {
  await assert.rejects(() => planRegistryUpdate("frizz", "1.2.3", { latestVersion: async () => { throw new Error("offline"); } }), /offline/);
});

test("npm runs as node + npm-cli.js — the bare `npm` name is only a `.cmd` shim on Windows", () => {
  const node = join("/", "opt", "node", "bin", "node");
  const cli = join("/", "opt", "node", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const exists = (path: string) => path === cli;
  // npm hands every bin it runs its own entry point; `npx` may hand down npx-cli.js instead.
  assert.deepEqual(resolveNpmInvocation({ npm_execpath: cli }, node, exists), { command: node, prefixArgs: [cli] });
  assert.deepEqual(resolveNpmInvocation({ npm_execpath: join("/", "opt", "node", "lib", "node_modules", "npm", "bin", "npx-cli.js") }, node, exists), { command: node, prefixArgs: [cli] });
  // Without the hint, the npm that ships beside this node binary is found from execPath alone.
  assert.deepEqual(resolveNpmInvocation({}, node, exists), { command: node, prefixArgs: [cli] });
  const windowsNode = join("C:", "Program Files", "nodejs", "node.exe");
  const windowsCli = join("C:", "Program Files", "nodejs", "node_modules", "npm", "bin", "npm-cli.js");
  assert.deepEqual(resolveNpmInvocation({}, windowsNode, (path) => path === windowsCli), { command: windowsNode, prefixArgs: [windowsCli] });
  // A stale hint that points nowhere is skipped, and with no script at all the bare command remains.
  assert.deepEqual(resolveNpmInvocation({ npm_execpath: join("/", "gone", "npm-cli.js") }, node, exists), { command: node, prefixArgs: [cli] });
  assert.deepEqual(resolveNpmInvocation({}, node, () => false), { command: "npm", prefixArgs: [] });
});

test("the resolved npm invocation actually starts on this platform", async () => {
  // Pins the spawn, not the registry: before this, Windows failed with `spawn npm ENOENT` because the
  // bare name only reaches a `.cmd` shim there. `--version` is the cheapest thing npm answers offline.
  const npm = resolveNpmInvocation();
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(npm.command, [...npm.prefixArgs, "--version"], { encoding: "utf8" }, (error, out) => error ? reject(error) : resolve(out));
  });
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/u);
});

test("successor handoff uses npm exec rather than replacing the active npx cache", () => {
  const child = fakeChild();
  let captured: Parameters<RegistryReleaseAdapter["spawnNpmExec"]>[0] | undefined;
  handoffToRegistrySuccessor(
    { packageName: "frizz", currentVersion: "1.2.3", latestVersion: "1.3.0", packageSpec: "frizz@1.3.0" },
    { port: 4917, projectDir: "/repo", cwd: "/repo", env: { FRIZZ_LAUNCH_OWNER_TOKEN: "lease" } },
    { spawnNpmExec: (request) => { captured = request; return child as never; } },
  );
  assert.deepEqual(captured?.args, [PRODUCTION_REEXEC_FLAG, "--port", "4917", "/repo"]);
  assert.equal(captured?.packageSpec, "frizz@1.3.0");
  // The invoked bin tracks the package name so a renamed release (e.g. frizz) can't invoke a stale bin.
  assert.equal(captured?.bin, "frizz");
  assert.equal(captured?.env.FRIZZ_LAUNCH_OWNER_TOKEN, "lease");
  assert.equal(captured?.env.FRIZZ_REGISTRY_VERSION, "1.3.0");
  assert.equal(child.unrefCalls, 1);
});
