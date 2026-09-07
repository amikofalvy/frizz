import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const PRODUCTION_REEXEC_FLAG = "--_frizz-production-reexec";

export interface NpmInvocation {
  command: string;
  /** Arguments that go BEFORE the npm subcommand (the npm-cli.js script when node runs npm directly). */
  prefixArgs: string[];
}

/**
 * How to start npm from this process. `execFile("npm", …)` is not enough on Windows. There npm is only
 * a `npm.cmd` shim. A shell-less spawn cannot find the shim (`spawn npm ENOENT`), and Node refuses to
 * run a `.cmd` file without a shell. The reliable form is the one every shim ends in: this node binary
 * running `npm-cli.js`. Three places can hold that script, in this order:
 *
 *   1. beside `npm_execpath`, which npm sets for a bin it runs itself (`npx frizz`, `npm exec`);
 *   2. beside node.exe (the Windows installer layout);
 *   3. under `../lib/node_modules` (the POSIX installer layout).
 *
 * A global bin started from a shell has no `npm_execpath`, so it gets the npm that ships with node.
 * On POSIX the bare `npm` command is the fallback, which is the behaviour before this helper existed.
 * On Windows there is no working fallback: the bare name only reaches the shim, and a swallowed spawn
 * error would end the board with a success message. So Windows throws instead.
 */
export function resolveNpmInvocation(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform
): NpmInvocation {
  const nodeDir = dirname(execPath);
  const candidates = [
    // pnpm, yarn and bun set `npm_execpath` too, to their own entry file. Their directories hold no
    // `npm-cli.js`, so the existence check below skips them.
    env.npm_execpath ? join(dirname(env.npm_execpath), "npm-cli.js") : undefined,
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate): candidate is string => candidate !== undefined);
  const script = candidates.find((candidate) => exists(candidate));
  if (script) return { command: execPath, prefixArgs: [script] };
  if (platform === "win32") {
    throw new Error(`npm-cli.js not found beside ${execPath} (searched: ${candidates.join(", ")})`);
  }
  return { command: "npm", prefixArgs: [] };
}

export interface RegistryReleaseAdapter {
  latestVersion(packageName: string): Promise<string>;
  /**
   * Install one immutable release into its own directory and return the absolute path of its bin
   * script. The directory is private to that version, so a later install never touches a running one.
   */
  installRelease(request: { packageName: string; packageSpec: string; releaseDir: string }): Promise<string>;
  /** Start a successor as `node <entry> …` with no console window. */
  spawnEntry(request: { entry: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }): ChildProcess;
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
  /** Set once the release is installed locally: the bin script the successor starts from. */
  entry?: string;
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

/** Where installed releases live: one directory per version under the user's frizz home. */
export function defaultReleasesDir(home: string = homedir()): string {
  return join(home, ".frizz", "releases");
}

/**
 * Make the successor startable BEFORE the running board drains. On Windows that means an install:
 * `npm exec` runs a bin through `cmd.exe`, and a console program started from a process without a
 * console gets a new, visible console window. The updated board would then live in that window, and
 * closing the window would stop it. So Windows installs the release into a private directory here,
 * while the board is still up, and later starts `node <bin>` directly. POSIX keeps `npm exec`: a
 * detached process has no window there, and that path is the one verified on those platforms.
 */
export async function prepareRegistrySuccessor(
  plan: RegistryUpdatePlan,
  adapter: Pick<RegistryReleaseAdapter, "installRelease">,
  options: { platform?: NodeJS.Platform; releasesDir?: string; fs?: Parameters<typeof pruneReleases>[3] } = {}
): Promise<RegistryUpdatePlan> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || plan.entry) return plan;
  const releasesDir = options.releasesDir ?? defaultReleasesDir();
  const releaseDir = join(releasesDir, `${plan.packageName}-${plan.latestVersion}`);
  const entry = await adapter.installRelease({ packageName: plan.packageName, packageSpec: plan.packageSpec, releaseDir });
  // Only after the install succeeded: a failed install must leave the last good release in place.
  // Cleanup can fail (a stale release still holds a file open) without endangering the healthy board.
  try {
    pruneReleases(releasesDir, plan.packageName, [plan.currentVersion, plan.latestVersion], options.fs);
  } catch {
    // Bounded disk use is best effort; the update itself does not depend on it.
  }
  return { ...plan, entry };
}

/**
 * Keep the releases directory bounded: every successful update installs a complete package tree, so
 * without this the directory grows by one install per release. Removes each `<packageName>-<version>`
 * directory except the versions named in `keep` — the one that may still be executing and the one being
 * prepared. Other names are left alone. Returns the names it removed.
 */
export function pruneReleases(
  releasesDir: string,
  packageName: string,
  keep: readonly string[],
  fs: { readdirSync: typeof readdirSync; rmSync: typeof rmSync } = { readdirSync, rmSync }
): string[] {
  const prefix = `${packageName}-`;
  const keepNames = new Set(keep.map((version) => `${prefix}${version}`));
  const removed: string[] = [];
  for (const dirent of fs.readdirSync(releasesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory() || !dirent.name.startsWith(prefix) || keepNames.has(dirent.name)) continue;
    fs.rmSync(join(releasesDir, dirent.name), { recursive: true, force: true });
    removed.push(dirent.name);
  }
  return removed;
}

/**
 * Start a successor and let this process go. A prepared plan (Windows) starts `node <bin>` from the
 * installed release. Otherwise npm gets a separate, immutable execution cache and runs the bin from
 * there. Neither form edits the package directory that npx is currently executing, which npm might
 * share or delete while the durable supervisor is still live.
 */
export function handoffToRegistrySuccessor(
  plan: RegistryUpdatePlan,
  request: { port: number; cwd: string; env: NodeJS.ProcessEnv },
  adapter: Pick<RegistryReleaseAdapter, "spawnNpmExec" | "spawnEntry">
): void {
  // The successor learns its project from the launch environment (FRIZZ_LAUNCH_PROJECT_DIR and
  // friends), never from an argument: the launcher rejects a positional path since bc037f17, and a
  // successor started with one died on "unexpected argument" before it could log (found 2026-09-07).
  const args = [PRODUCTION_REEXEC_FLAG, "--port", String(request.port)];
  const env = {
    ...request.env,
    FRIZZ_REGISTRY_PACKAGE: plan.packageName,
    FRIZZ_REGISTRY_VERSION: plan.latestVersion,
  };
  const child = plan.entry
    ? adapter.spawnEntry({ entry: plan.entry, args, cwd: request.cwd, env })
    : adapter.spawnNpmExec({
        packageSpec: plan.packageSpec,
        // The published bin name tracks the package name (frizz). Never hardcode a stale bin here or
        // a renamed release would resolve the new package but invoke a bin that no longer exists.
        bin: plan.packageName,
        args,
        cwd: request.cwd,
        env,
      });
  child.once("error", () => {});
  child.unref();
}

/** The bin script of an installed package, read from its manifest. */
export function installedBinEntry(packageName: string, releaseDir: string, readManifest: (path: string) => string = (path) => readFileSync(path, "utf8")): string {
  const packageDir = join(releaseDir, "node_modules", packageName);
  const manifest = JSON.parse(readManifest(join(packageDir, "package.json"))) as { version?: string; bin?: string | Record<string, string> };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[packageName];
  if (!bin) throw new Error(`${packageName} ${manifest.version ?? ""} has no bin named ${packageName}`);
  return resolve(packageDir, bin);
}

export const npmRegistryReleaseAdapter: RegistryReleaseAdapter = {
  latestVersion(packageName) {
    return new Promise((resolveVersion, reject) => {
      let npm: NpmInvocation;
      try { npm = resolveNpmInvocation(); } catch (error) { return reject(error); }
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
  installRelease({ packageName, packageSpec, releaseDir }) {
    return new Promise((resolveEntry, reject) => {
      let npm: NpmInvocation;
      try { npm = resolveNpmInvocation(); } catch (error) { return reject(error); }
      mkdirSync(releaseDir, { recursive: true });
      // `--prefix` puts the package under <releaseDir>/node_modules. No lockfile and no audit: this
      // directory is an install target, not a project.
      const args = [...npm.prefixArgs, "install", "--prefix", releaseDir, "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error", packageSpec];
      execFile(npm.command, args, { encoding: "utf8", windowsHide: true, timeout: 15 * 60 * 1000 }, (error, _stdout, stderr) => {
        if (error) return reject(new Error(`could not install ${packageSpec}: ${error.message}${stderr ? `\n${stderr.trim()}` : ""}`));
        try {
          const entry = installedBinEntry(packageName, releaseDir);
          if (!existsSync(entry)) throw new Error(`${packageSpec} installed without its bin at ${entry}`);
          resolveEntry(entry);
        } catch (failure) {
          reject(failure);
        }
      });
    });
  },
  spawnEntry({ entry, args, cwd, env }) {
    // `detached` gives the successor no console of its own, and `windowsHide` keeps the children it
    // starts from opening one. Measured on Windows Server 2022: without `windowsHide` a forked child of
    // a console-less parent gets a visible console window; with it, the child and its children get none.
    return spawn(process.execPath, [entry, ...args], {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
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
