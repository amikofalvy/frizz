import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "./launcher.ts";
import {
  PRODUCTION_PRINT_LAUNCHER_FLAG,
  PRODUCTION_REEXEC_FLAG,
  handoffToRegistrySuccessor,
  planRegistryUpdate,
  reexecIntoRegistrySuccessor,
  resolveRegistrySuccessor,
  reexecArgv,
  successorArgs,
  type RegistryReleaseAdapter,
  type RegistrySuccessor,
} from "./production-update.ts";

const plan = { packageName: "frizz", currentVersion: "1.2.3", latestVersion: "1.3.0", packageSpec: "frizz@1.3.0" };
// A file that exists, standing in for the successor's launcher bundle.
const thisFile = fileURLToPath(import.meta.url);

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
  assert.deepEqual(await planRegistryUpdate("frizz", "1.2.3", { latestVersion: async () => "1.3.0" }), plan);
});

test("registry lookup failure leaves the healthy process untouched", async () => {
  await assert.rejects(() => planRegistryUpdate("frizz", "1.2.3", { latestVersion: async () => { throw new Error("offline"); } }), /offline/);
});

// The 2026-09-10 failure, pinned at the seam that produced it: the successor was started with the
// project directory as a positional argument, which parseCliArgs has refused since the singleton
// launch — so every registry update started a successor that died on its first line, unseen.
test("the successor's argv is one parseCliArgs accepts: the re-exec flag, the port, and no repository path", () => {
  const args = successorArgs(4917);
  assert.deepEqual(args, [PRODUCTION_REEXEC_FLAG, "--port", "4917"]);
  const parsed = parseCliArgs(args.filter((arg) => arg !== PRODUCTION_REEXEC_FLAG));
  assert.equal(parsed.port, 4917);
});

// The other half of that failure, seen from the SUCCESSOR: the launcher that starts it is the previous
// release, and every release from 0.7.0 to 0.12.10 still appends the project directory. A successor that
// refuses it is one no install in the field can update into (measured 2026-09-11: 0.12.10 -> 0.12.11
// printed "taking over", then ECONNREFUSED for good). The directory is dropped; the port survives.
test("a re-exec'd launcher drops the project directory an older launcher appends, and keeps its port", () => {
  const legacy = [PRODUCTION_REEXEC_FLAG, "--port", "4917", "/Users/someone/code/app"];
  assert.deepEqual(reexecArgv(legacy), ["--port", "4917"]);
  assert.equal(parseCliArgs(reexecArgv(legacy)).port, 4917);
  // The current successor argv is unchanged by the same pass.
  assert.deepEqual(reexecArgv(successorArgs(4917)), ["--port", "4917"]);
  // Flags survive in place, and a directory before the flags is dropped too.
  assert.deepEqual(reexecArgv(["/repo", PRODUCTION_REEXEC_FLAG, "--no-app", "--port=4918"]), ["--no-app", "--port=4918"]);
});

test("resolving the successor installs it through npm exec and reads its launcher entry off stdout", async () => {
  let captured: Parameters<RegistryReleaseAdapter["npmExec"]>[0] | undefined;
  const successor = await resolveRegistrySuccessor(plan, { cwd: "/repo", env: { FRIZZ_LAUNCH_OWNER_TOKEN: "lease" } }, {
    npmExec: async (request) => {
      captured = request;
      // npm may print its own lines first (a funding notice, a config warning); the entry is the last one.
      return { code: 0, signal: null, stdout: `npm warn Unknown project config "node-linker"\n${thisFile}\n`, stderr: "" };
    },
  });
  assert.equal(successor.entry, thisFile);
  assert.equal(successor.plan, plan);
  assert.equal(captured?.packageSpec, "frizz@1.3.0");
  // The invoked bin tracks the package name so a renamed release can't invoke a stale bin.
  assert.equal(captured?.bin, "frizz");
  assert.deepEqual(captured?.args, [PRODUCTION_PRINT_LAUNCHER_FLAG]);
  assert.equal(captured?.env.FRIZZ_LAUNCH_OWNER_TOKEN, "lease");
});

test("a successor that npm cannot install or start fails the update BEFORE anything is drained, quoting stderr", async () => {
  await assert.rejects(
    () => resolveRegistrySuccessor(plan, { cwd: "/repo", env: {} }, {
      npmExec: async () => ({ code: 1, signal: null, stdout: "", stderr: "npm error 404 Not Found\nnpm error frizz@1.3.0 is not in this registry\n" }),
    }),
    /npm exec frizz@1\.3\.0 failed \(exit 1\): npm error 404 Not Found\nnpm error frizz@1\.3\.0 is not in this registry/,
  );
  await assert.rejects(
    () => resolveRegistrySuccessor(plan, { cwd: "/repo", env: {} }, {
      npmExec: async () => ({ code: 0, signal: null, stdout: "dist/frizz.js\n", stderr: "" }),
    }),
    /did not report its launcher entry/,
  );
  await assert.rejects(
    () => resolveRegistrySuccessor(plan, { cwd: "/repo", env: {} }, {
      npmExec: async () => ({ code: 0, signal: null, stdout: "/definitely/not/here/frizz.js\n", stderr: "" }),
    }),
    /did not report its launcher entry/,
  );
});

test("the in-place handoff execve's node onto the resolved entry with the lease and the release in the environment", () => {
  const successor: RegistrySuccessor = { plan, entry: thisFile };
  let captured: { file: string; args: string[]; env: NodeJS.ProcessEnv } | undefined;
  assert.throws(() =>
    reexecIntoRegistrySuccessor(successor, { port: 4917, env: { FRIZZ_LAUNCH_OWNER_TOKEN: "lease" } }, (file, args, env) => {
      captured = { file, args, env };
      throw new Error("execve stand-in");
    }),
  /execve stand-in/);
  assert.equal(captured?.file, process.execPath);
  assert.deepEqual(captured?.args, [process.execPath, thisFile, PRODUCTION_REEXEC_FLAG, "--port", "4917"]);
  assert.equal(captured?.env.FRIZZ_LAUNCH_OWNER_TOKEN, "lease");
  assert.equal(captured?.env.FRIZZ_REGISTRY_PACKAGE, "frizz");
  assert.equal(captured?.env.FRIZZ_REGISTRY_VERSION, "1.3.0");
});

test("the detached fallback starts the resolved entry, not another npm exec, and lets go of it", () => {
  const child = fakeChild();
  let captured: Parameters<RegistryReleaseAdapter["spawnDetached"]>[0] | undefined;
  handoffToRegistrySuccessor(
    { plan, entry: thisFile },
    { port: 4917, cwd: "/repo", env: { FRIZZ_LAUNCH_OWNER_TOKEN: "lease" } },
    { spawnDetached: (request) => { captured = request; return child as never; } },
  );
  assert.equal(captured?.entry, thisFile);
  assert.deepEqual(captured?.args, [PRODUCTION_REEXEC_FLAG, "--port", "4917"]);
  assert.equal(captured?.env.FRIZZ_LAUNCH_OWNER_TOKEN, "lease");
  assert.equal(captured?.env.FRIZZ_REGISTRY_VERSION, "1.3.0");
  assert.equal(child.unrefCalls, 1);
});
