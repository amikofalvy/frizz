// Where a relative path written in prose points. Agents name files the way they typed them into a
// shell — `packages/web/src/App.tsx`, `.frizz/threads/<id>/HANDOFF.md`, `~/.claude/CLAUDE.md` — and the
// server has always resolved those against the project directory for a path in INLINE CODE
// (local-file.ts `resolveOpenableFile`, behind rpc.resolveLocalPaths). A path written as a Markdown
// LINK had no such base in chat, so it stayed a relative href and the browser resolved it against the
// PAGE: clicking one navigated to `/project/<slug>/thread/<slug>/<the path>` and out of the app.
//
// Module-level rather than an argument threaded through every `mdToHtml` call, for exactly the reason
// githubAutolink.ts holds its repo that way: a page shows ONE project at a time, there are a dozen
// render sites each memoizing on its own markdown string, and a project switch tears every one of them
// down (resetProjectState). Set from the board — the one payload that carries both values.
//
// It NOTIFIES, and that is load-bearing, not defensive: a thread's transcript is its own query and it
// resolves BEFORE the board keyframe, so HTML memoized on the markdown string alone would be built
// while this was still empty and nothing would ever invalidate it. useMarkdownHtml subscribes so the
// base is a real render input. (Measured for the repo autolinker in exactly that shape — see
// githubAutolink.ts `setGithubRepo`.)

export interface LocalPathBase {
  /** The project root a relative path resolves against, or "" before the board has arrived. */
  dir: string
  /** The server's home directory, for a `~`-anchored path. "" when the server did not supply one. */
  home: string
}

const EMPTY: LocalPathBase = { dir: "", home: "" }

let base: LocalPathBase = EMPTY
const listeners = new Set<() => void>()

/** Point relative-path resolution at this page's project. Called from the board's own door (store.ts). */
export function setLocalPathBase(dir: string | null | undefined, home?: string | null): void {
  const next: LocalPathBase = { dir: dir ?? "", home: home ?? "" }
  if (next.dir === base.dir && next.home === base.home) return
  // A STABLE IDENTITY when nothing changed is the whole reason for the guard above: useSyncExternalStore
  // compares snapshots by reference and re-renders forever on a fresh object per read.
  base = next.dir || next.home ? next : EMPTY
  for (const listener of listeners) listener()
}

/** The base relative paths resolve against — the `getSnapshot` half of the subscription. */
export function localPathBase(): LocalPathBase {
  return base
}

export function subscribeLocalPathBase(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// THE CONSOLE'S BASES. The Console shows every project on one page, so "this page's project" names
// none of them and the page base above stays empty there (store.ts refuses the union board at its door,
// and the binding's reset clears it). A card or drawer on it still belongs to ONE project — the one its
// <ProjectScope> names — and a relative path in that surface's prose means that project's directory,
// exactly as it would on the project's own page. So the Console registers each open project's directory
// here (lib/consoleProjects.ts, from the project list it already reads), with the machine's home, and a
// surface asks for its project's base by name. Off the Console the map is empty and every surface gets
// the page base: nothing about a project page changes.
let projectDirs: ReadonlyMap<string, string> = new Map()
let projectHome = ""
// One stable object per project for as long as its directory and the home are unchanged — the same
// useSyncExternalStore identity rule as `setLocalPathBase`.
let projectBases = new Map<string, LocalPathBase>()

/** The Console's open projects (`slug → directory`) and the server's home. An empty map off the Console. */
export function setProjectPathBases(dirs: Iterable<readonly [string, string]>, home?: string | null): void {
  const next = new Map(dirs)
  const nextHome = home ?? ""
  const same = nextHome === projectHome && next.size === projectDirs.size && [...next].every(([slug, dir]) => projectDirs.get(slug) === dir)
  if (same) return
  projectDirs = next
  projectHome = nextHome
  projectBases = new Map()
  for (const listener of listeners) listener()
}

/** A project's directory as the Console knows it, or "" when it is not one of the Console's projects. */
export function projectPathDir(project: string): string {
  return projectDirs.get(project) ?? ""
}

/**
 * The base a surface's relative paths resolve against: its project's, when it names one the Console
 * knows, else the page's. `project` is the surface's <ProjectScope> (undefined on a project's own page).
 */
export function localPathBaseFor(project: string | undefined): LocalPathBase {
  const dir = project ? projectDirs.get(project) : undefined
  if (project && dir) {
    let scoped = projectBases.get(project)
    if (!scoped) projectBases.set(project, (scoped = { dir, home: projectHome }))
    return scoped
  }
  // A surface on the Console with no project of its own (the Markdown reader, which names its own
  // directory) still expands `~`: the home is the machine's, not a project's.
  if (projectHome && base === EMPTY) {
    let homeOnly = projectBases.get("")
    if (!homeOnly) projectBases.set("", (homeOnly = { dir: "", home: projectHome }))
    return homeOnly
  }
  return base
}
