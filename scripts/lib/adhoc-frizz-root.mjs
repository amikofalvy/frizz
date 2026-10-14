// WHERE A DISPOSABLE STACK KEEPS FRIZZ'S OWN STATE, decided from the HOME it runs under.
//
// `<home>/.frizz` is the LEGACY root, and its existence alone is a machine-wide switch: `frizzPaths()`
// answers "use it for everything, forever" the moment the folder is there (packages/server/src/
// frizz-paths.ts, rule 1). Under a sandbox HOME that is what a stack wants. Under the REAL home of a
// machine whose Frizz lives in the platform's own location (macOS Application Support, XDG,
// LocalAppData) it is a trap: creating the folder moves every Frizz process started afterwards, the
// maintainer's own server on its next start included, onto an empty tree, with the real boards still
// on disk and nothing reading them.
//
// `adhoc-stack.mjs --home=$HOME` did exactly that until 2026-10-13. It made `~/.frizz` whatever HOME
// it was handed, ran isolated inside it, and left it behind (`--home` implies `--keep`), 568 MB of
// re-downloaded runtimes included. It was caught on a machine with 14 projects under Application
// Support, five minutes after the folder appeared and before anything real had started on it.
//
// So a real HOME is never given a legacy root:
//   sandbox   the HOME is the stack's own (a temp dir, or one a `--keep` run left behind): `<home>/.frizz`
//   shared    the real HOME, and the machine's Frizz already lives in `~/.frizz`: use it as it is
//   isolated  the real HOME with no `~/.frizz`: a temp root of the stack's own, named by the XDG
//             variables, which `frizzPaths()` honors on every platform
import { realpathSync } from "node:fs"
import { resolve } from "node:path"

function canonical(dir) {
  try { return realpathSync(dir) } catch { return resolve(dir) }
}

/** @returns {"sandbox" | "shared" | "isolated"} */
export function adhocFrizzRoot({ home, realHome, legacyExists }) {
  if (!realHome || canonical(home) !== canonical(realHome)) return "sandbox"
  return legacyExists ? "shared" : "isolated"
}
