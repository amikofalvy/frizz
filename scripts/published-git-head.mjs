// npm can acknowledge publication before its read replicas expose the version. Wait for that exact
// version, never substitute the workflow checkout: a later server-only release can reconcile a shell.
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"

export async function publishedGitHead(name, version, {
  registry = "https://registry.npmjs.org/", timeoutMs = 120_000, intervalMs = 2000,
} = {}) {
  const url = new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, registry)
  const deadline = Date.now() + timeoutMs
  let last = "not visible"
  while (Date.now() < deadline) {
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))) })
    if (response.ok) {
      const metadata = await response.json()
      if (metadata.name !== name || metadata.version !== version || !/^[0-9a-f]{40}$/.test(metadata.gitHead ?? "")) {
        throw new Error(`${name}@${version} has no matching registry gitHead; refusing to tag a different checkout`)
      }
      return metadata.gitHead
    }
    await response.body?.cancel()
    last = `HTTP ${response.status}`
    if (response.status !== 404 && response.status !== 429 && response.status < 500) {
      throw new Error(`${name}@${version}: ${last}`)
    }
    await delay(Math.max(0, Math.min(intervalMs, deadline - Date.now())))
  }
  throw new Error(`Timed out reading published ${name}@${version}: ${last}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [name, version] = process.argv.slice(2)
  if (!name || !version) throw new Error("usage: published-git-head.mjs PACKAGE VERSION")
  console.log(await publishedGitHead(name, version))
}
