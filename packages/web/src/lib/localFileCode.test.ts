import { test } from "node:test"
import assert from "node:assert/strict"
import { isPathCandidate, resolveScope, resolvedLocalFile, resolveUnknown } from "./localFileCode.ts"

test("isPathCandidate accepts path-like inline code", () => {
  for (const v of [
    "~/.claude/CLAUDE.md",
    "~",
    "/Users/me/artifacts/shot.png",
    "packages/web/src/App.tsx",
    "./foo/bar.ts",
    "../sibling/x.md",
    "packages/web/src/App.tsx:42:7", // an editor :line[:col] suffix is still a candidate (stripped server-side)
    "a/b", // any slash-bearing token is a candidate; the server decides if it's real
    // A bare filename with an extension — how a worker names a file it wrote at the project root
    // (`it's in \`cloudflare-ask.md\``). Resolved against the project dir server-side, like any
    // other relative path.
    "cloudflare-ask.md",
    "package.json",
    "App.tsx",
    "pnpm-lock.yaml",
    "notes@2026-08-25.md",
  ]) assert.equal(isPathCandidate(v), true, v)
})

test("isPathCandidate rejects non-paths: commands, bare words, URLs, whitespace, and over-long text", () => {
  for (const v of [
    "git status", // whitespace → a command, not a path
    "npm run build",
    "useState", // bare identifier, no slash
    "README", // bare word, no extension
    "1.5", // a version, not a file: the "extension" opens with a digit
    "v1.2",
    "e.g.", // an abbreviation ends on its dot, so there is no extension at all
    "foo.", // nor here
    ".env", // a dotfile has no stem before its one dot; the bare-filename rule needs both
    "https://example.com/x.png", // URL
    "file:///Users/me/x.png", // URL scheme
    "cursor://file/Users/me/x.png", // URL scheme
    "", // empty
    "  ", // whitespace only
    `/${"x".repeat(2000)}`, // over the length cap
  ]) assert.equal(isPathCandidate(v), false, v)
})

test("isPathCandidate accepts a Windows path and rejects a backslash escape (Windows audit 2026-09-11, finding 12)", () => {
  for (const v of [
    "C:\\Users\\me\\proj\\src\\a.ts",
    "c:\\a.ts",
    "C:/Users/me/proj/src/a.ts",
    "src\\a.ts",
    "~\\.claude\\CLAUDE.md",
    "\\\\server\\share\\a.md",
    "packages\\web\\src\\App.tsx:42:7",
  ]) assert.equal(isPathCandidate(v), true, v)
  for (const v of [
    "\\n", // an escape, not a root
    "\\d+",
    "^\\s+$",
    "\\\\",
    "\\",
    "C:", // a bare drive names nothing
    "a\\\\b", // a doubled separator mid-path is an escaped backslash, not a directory
  ]) assert.equal(isPathCandidate(v), false, v)
})

// A stand-in server: each project resolves a relative path against its OWN directory, as router.ts
// `resolveLocalPaths` does against `ctx.project.dir`. Records which project each batch was sent to.
function stubServer(pathname: string) {
  const g = globalThis as { location?: unknown; fetch: typeof fetch }
  const saved = { location: g.location, fetch: g.fetch }
  const asked: { project: string; paths: string[] }[] = []
  const page = { pathname, origin: "http://frizz.test" }
  g.location = page
  g.fetch = (async (url: string) => {
    const u = new URL(url)
    const project = /^\/_frizz\/(?:([^/]+)\/)?rpc\/resolveLocalPaths$/.exec(u.pathname)?.[1] ?? "(launching)"
    const paths = (JSON.parse(u.searchParams.get("input") ?? "{}") as { paths: string[] }).paths
    asked.push({ project, paths })
    const resolved = paths.map((input) => ({ input, path: input.startsWith("/") ? input : `/code/${project}/${input}` }))
    return new Response(JSON.stringify({ result: { resolved } }), { headers: { "content-type": "application/json" } })
  }) as typeof fetch
  return { asked, page, restore: () => { g.location = saved.location; g.fetch = saved.fetch } }
}

// Review finding 3 (2026-10-11): on the Console every batch went to `fileRpc(chunk[0])`, which for a relative
// path is the FIRST open project, and the answer was cached by its text alone — so project B's card linked
// `README.md` to project A's file, and so did every card after it. Each surface now asks its own project.
test("on the Console a relative path resolves in the project of the card that names it", async () => {
  const server = stubServer("/console")
  try {
    const acme = resolveScope("acme", "/console")
    const billing = resolveScope("billing", "/console")
    await Promise.all([resolveUnknown(billing, ["README-3.md", "src/x-3.ts"]), resolveUnknown(acme, ["README-3.md"])])
    assert.deepEqual(
      server.asked.map((a) => a.project).sort(), ["acme", "billing"], "one batch per project, each to its own API",
    )
    assert.equal(resolvedLocalFile(billing, "README-3.md"), "/code/billing/README-3.md")
    assert.equal(resolvedLocalFile(billing, "src/x-3.ts"), "/code/billing/src/x-3.ts")
    assert.equal(resolvedLocalFile(acme, "README-3.md"), "/code/acme/README-3.md")
    assert.equal(resolvedLocalFile(acme, "src/x-3.ts"), undefined, "billing's answer is not acme's")
    // Asked once per project: a second surface of the same project reads the cache.
    await resolveUnknown(resolveScope("billing", "/console"), ["README-3.md"])
    assert.equal(server.asked.length, 2)
  } finally {
    server.restore()
  }
})

// The half that predates the Console: the cache outlived a switch between two project pages.
test("two project pages keep their answers for the same text apart", async () => {
  const server = stubServer("/project/acme")
  try {
    const onAcme = resolveScope(undefined)
    await resolveUnknown(onAcme, ["README-page.md"])
    server.page.pathname = "/project/billing"
    const onBilling = resolveScope(undefined)
    assert.equal(resolvedLocalFile(onBilling, "README-page.md"), undefined, "acme's answer is not billing's")
    await resolveUnknown(onBilling, ["README-page.md"])
    assert.deepEqual(server.asked.map((a) => a.project), ["acme", "billing"])
    assert.equal(resolvedLocalFile(onAcme, "README-page.md"), "/code/acme/README-page.md")
    assert.equal(resolvedLocalFile(onBilling, "README-page.md"), "/code/billing/README-page.md")
  } finally {
    server.restore()
  }
})

// The Console's Markdown reader has no ProjectScope: a relative path there has no directory to mean, so it
// is not sent to an arbitrary project — it stays plain code.
test("on the Console a surface with no project never borrows one for a relative path", async () => {
  const server = stubServer("/console")
  try {
    const unscoped = resolveScope(undefined, "/console")
    await resolveUnknown(unscoped, ["src/unscoped.ts", "README-unscoped.md"])
    assert.deepEqual(server.asked, [])
    assert.equal(resolvedLocalFile(unscoped, "src/unscoped.ts"), null)
  } finally {
    server.restore()
  }
})
