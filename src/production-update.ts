import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const PRODUCTION_REEXEC_FLAG = "--_frizz-production-reexec";

export interface NpmInvocation {
  command: string;
  /** Arguments that go BEFORE the npm subcommand (the npm-cli.js script when node runs npm directly). */
  prefixArgs: string[];
}

/**
 * How to start npm from this process. `execFile("npm", …)` is not enough: on Windows npm is only a
 * `npm.cmd` shim, which a shell-less spawn cannot find (`spawn npm ENOENT`) and which Node refuses to
 * run through a shell-less spawn anyway. npm itself sets `npm_execpath` for every bin it runs — this
 * process, under `npx frizz` — so the reliable form is the one every shim ends in: this node binary
 * running `npm-cli.js`. Only when no such script can be found does this fall back to the bare `npm`
 * command, which is fine on POSIX and is the pre-existing behaviour everywhere.
 */
export function resolveNpmInvocation(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  exists: (path: string) => boolean = existsSync
): NpmInvocation {
  const candidates: string[] = [];
  if (env.npm_execpath) {
    // `npx` may hand down npx-cli.js; the npm entry point lives beside it.
    const script = basename(env.npm_execpath) === "npx-cli.js" ? join(dirname(env.npm_execpath), "npm-cli.js") : env.npm_execpath;
    candidates.push(script);
  }
  const nodeDir = dirname(execPath);
  // The npm that ships with node: beside node.exe on Windows, under ../lib on POSIX installs.
  candidates.push(join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"));
  candidates.push(join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  for (const script of candidates) {
    if (basename(script) === "npm-cli.js" && exists(script)) return { command: execPath, prefixArgs: [script] };
  }
  return { command: "npm", prefixArgs: [] };
}

export interface RegistryReleaseAdapter {
  latestVersion(packageName: string): Promise<string>;
  spawnNpmExec(request: {
    packageSpec: string;
    /** Bin to invoke from the resolved package. Defaults to the package name (frizz). */
    bin: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): ChildProcess;
}

export interface RegistryUpdatePlan {
  packageName: string;
  currentVersion: string;
  latestVersion: string;
  packageSpec: string;
}

/**
 * Compare normal npm versions without bringing a runtime semver dependency into the launcher.
 * Unknown/non-semver versions deliberately never self-update: an operator can still run npx with
 * an explicit tag, but the browser button must fail closed rather than downgrade or guess.
 */
export function compareReleaseVersions(a: string, b: string): number | null {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
    if (!match) return null;
    return { numeric: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] };
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let index = 0; index < left.numeric.length; index++) {
    const delta = left.numeric[index]! - right.numeric[index]!;
    if (delta) return delta < 0 ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

export async function planRegistryUpdate(
  packageName: string,
  currentVersion: string,
  adapter: Pick<RegistryReleaseAdapter, "latestVersion">
): Promise<RegistryUpdatePlan | null> {
  const latestVersion = (await adapter.latestVersion(packageName)).trim();
  const comparison = compareReleaseVersions(currentVersion, latestVersion);
  if (comparison === null)
    throw new Error(`cannot safely compare installed Frizz version ${currentVersion} with registry version ${latestVersion}`);
  if (comparison >= 0) return null;
  return { packageName, currentVersion, latestVersion, packageSpec: `${packageName}@${latestVersion}` };
}

/**
 * Ask npm for a separate, immutable execution cache and start a successor from it.  This never
 * edits the package directory that npx is currently executing, which might be shared or deleted
 * by npm while the durable supervisor is still live.
 */
export function handoffToRegistrySuccessor(
  plan: RegistryUpdatePlan,
  request: { port: number; projectDir: string; cwd: string; env: NodeJS.ProcessEnv },
  adapter: Pick<RegistryReleaseAdapter, "spawnNpmExec">
): void {
  const child = adapter.spawnNpmExec({
    packageSpec: plan.packageSpec,
    // The published bin name tracks the package name (frizz). Never hardcode a stale bin here or
    // a renamed release would resolve the new package but invoke a bin that no longer exists.
    bin: plan.packageName,
    args: [PRODUCTION_REEXEC_FLAG, "--port", String(request.port), request.projectDir],
    cwd: request.cwd,
    env: {
      ...request.env,
      FRIZZ_REGISTRY_PACKAGE: plan.packageName,
      FRIZZ_REGISTRY_VERSION: plan.latestVersion,
    },
  });
  child.once("error", () => {});
  child.unref();
}

export const npmRegistryReleaseAdapter: RegistryReleaseAdapter = {
  latestVersion(packageName) {
    return new Promise((resolveVersion, reject) => {
      const npm = resolveNpmInvocation();
      execFile(npm.command, [...npm.prefixArgs, "view", `${packageName}@latest`, "version", "--json"], { encoding: "utf8" }, (error, stdout) => {
        if (error) return reject(new Error(`could not check npm for ${packageName}: ${error.message}`));
        try {
          const parsed = JSON.parse(stdout) as unknown;
          resolveVersion(typeof parsed === "string" ? parsed : String(parsed));
        } catch {
          resolveVersion(stdout.trim().replaceAll('"', ""));
        }
      });
    });
  },
  spawnNpmExec({ packageSpec, bin, args, cwd, env }) {
    // The explicit package spec forces npm to resolve/install a new cache entry before running it.
    const npm = resolveNpmInvocation();
    return spawn(npm.command, [...npm.prefixArgs, "exec", "--yes", `--package=${packageSpec}`, "--", bin, ...args], {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
    });
  },
};
