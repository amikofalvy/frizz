import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Where a SECRET answer goes instead of the database — the value the human pasted into a masked card
 * (`mcp__frizz__secret`): a one-time code, a token, a password.
 *
 * WHY A FILE. Every other answer is stored in `thread_question`, delivered in a wake the worker's
 * transcript keeps forever, and drawn on the settled card. A credential must reach none of those, and
 * the worker does not need to SEE it — only to pass it to a command. A file the worker reads inside the
 * command (`--otp "$(cat <path>)"`) gives it exactly that: the command line in the transcript carries
 * the path, never the value. The interaction store refuses secret provider answers for the same reason
 * (a durable outbox cannot carry one); a file outside the repo, readable only by this user, can.
 *
 * Under the project's STATE dir, never the repo: a value under `.frizz/` is one `git add -A` from a
 * commit. The directory is 0700 and the file 0600 — the same trust boundary as the provider
 * credentials beside it.
 *
 * NOT FOREVER. The worker is told to delete the file once it has used it, and every write sweeps files
 * past SECRET_FILE_TTL_MS, so a code nobody cleaned up does not outlive the day.
 */

export const SECRET_FILE_TTL_MS = 24 * 60 * 60_000

function secretsRoot(stateDir: string): string {
  return join(stateDir, "secrets")
}

/** The file a secret question's value lands in. Deterministic, so `ask` can name it at registration.
 *  Both segments are frizz-minted (a validated thread slug and a `qst_` id), never worker text. */
export function secretFilePath(stateDir: string, slug: string, questionId: string): string {
  return join(secretsRoot(stateDir), slug, questionId)
}

/** Write the value, private to this user, and sweep anything expired while here. */
export function writeSecretFile(stateDir: string, slug: string, questionId: string, value: string, now = Date.now()): string {
  const root = secretsRoot(stateDir)
  const dir = join(root, slug)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mkdir's mode only applies to directories it CREATES, and the umask narrows it further; a root left
  // by an older build or a hand-made one is tightened here rather than trusted.
  chmodSync(root, 0o700)
  chmodSync(dir, 0o700)
  const path = secretFilePath(stateDir, slug, questionId)
  writeFileSync(path, value, { mode: 0o600 })
  chmodSync(path, 0o600)
  sweepSecretFiles(stateDir, now)
  return path
}

/** Delete every secret file older than the TTL, and the thread directories that leaves empty. */
export function sweepSecretFiles(stateDir: string, now = Date.now(), ttlMs = SECRET_FILE_TTL_MS): number {
  const root = secretsRoot(stateDir)
  let removed = 0
  let threads: string[]
  try {
    threads = readdirSync(root)
  } catch {
    return 0
  }
  for (const thread of threads) {
    const dir = join(root, thread)
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const file of files) {
      const path = join(dir, file)
      try {
        if (now - statSync(path).mtimeMs > ttlMs) {
          rmSync(path, { force: true })
          removed++
        }
      } catch {}
    }
    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  return removed
}
