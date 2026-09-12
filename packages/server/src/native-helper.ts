import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface NativeHelperOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  resolvePty?: () => string;
  stat?: (path: string) => { mode: number };
  chmod?: (path: string, mode: number) => void;
}

/**
 * npm may skip node-pty's postinstall. Repair ONLY its packaged spawn-helper, from this server's
 * dependency tree, before any pty is opened. Never touch shell configuration or project permissions.
 * Windows uses conpty and has no helper. A missing/read-only helper is left to pty spawn to report.
 */
export function ensureNativeHelperPermissions(options: NativeHelperOptions = {}): void {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return;
  const stat = options.stat ?? ((path: string) => statSync(path));
  const chmod = options.chmod ?? ((path: string, mode: number) => chmodSync(path, mode));
  const resolvePty = options.resolvePty ?? (() => createRequire(import.meta.url).resolve("node-pty/package.json"));
  try {
    const helper = join(dirname(resolvePty()), "prebuilds", `${platform}-${options.arch ?? process.arch}`, "spawn-helper");
    const mode = stat(helper).mode;
    if ((mode & 0o111) === 0o111) return;
    chmod(helper, mode | 0o755);
  } catch { /* Best effort; the pty reports any actual failure. */ }
}
