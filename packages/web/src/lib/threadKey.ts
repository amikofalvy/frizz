// A THREAD'S NAME ON THE CONSOLE: `<project>~<thread>`.
//
// A thread slug is unique only WITHIN its project, and the Console shows every project's threads on one
// board. So the Console names each thread by its project and its slug together, and every slug-keyed
// thing the board already has — the drawer stack, the query cache, the queue card anchors, the per-slug
// maps in lib/ — keeps working by plain string identity.
//
// The key is minted HERE, in the browser, and never crosses the wire. `call()` in api/rpc.ts splits it
// back into a project (the URL it sends to) and a real slug (the input it sends), and the Console's feed
// (api/consoleFeed.ts) mints it from each project's own board. `~` is outside both slug grammars — a
// thread slug is `^[a-z0-9][a-z0-9-]*$` (shared/src/thread-slug.ts), a project slug is slugify output —
// so the split is unambiguous, and it is URL-safe, so `/console/thread/<key>` needs no escaping.

const SEPARATOR = "~"

export interface ThreadKeyParts {
  project: string
  slug: string
}

/** The Console's name for `slug` in `project`. */
export function threadKey(project: string, slug: string): string {
  return `${project}${SEPARATOR}${slug}`
}

/** A key split back into its project and real slug, or `null` for a plain slug. */
export function splitThreadKey(key: string): ThreadKeyParts | null {
  const at = key.indexOf(SEPARATOR)
  if (at <= 0 || at === key.length - 1) return null
  return { project: key.slice(0, at), slug: key.slice(at + 1) }
}

/** The real slug a key names, or the input unchanged when it is already a plain slug. */
export function bareSlug(keyOrSlug: string): string {
  return splitThreadKey(keyOrSlug)?.slug ?? keyOrSlug
}

/** The project a key names, or `undefined` for a plain slug. */
export function keyProject(keyOrSlug: string): string | undefined {
  return splitThreadKey(keyOrSlug)?.project
}
