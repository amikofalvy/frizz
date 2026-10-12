import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Frontmatter } from "./MarkdownDrawer.tsx"

const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")

test("frontmatter renders as indentation-preserving, syntax-highlighted YAML", () => {
  const source = [
    "title: Zod 4.5",
    "draft: false",
    "",
    "tags:",
    "  - zod",
    'summary: "a & b" # note',
  ].join("\n")
  const html = renderToStaticMarkup(createElement(Frontmatter, { source }))

  assert.match(html, /^<pre/)
  assert.match(html, /class="hljs [^"]*whitespace-pre-wrap/)
  assert.match(html, /<span class="hljs-attr">title:<\/span>/)
  assert.match(html, /<span class="hljs-literal">false<\/span>/)
  assert.match(html, /<span class="hljs-bullet">-<\/span>/)
  assert.match(html, /<span class="hljs-comment"># note<\/span>/)
  assert.equal(textOf(html), source)
})

// THE READER'S OPEN BUTTON ON THE CONSOLE. A reader drawer has no ProjectScope (it is named by its path,
// DrawerStack.tsx), so it must ask by path like every other file read (lib/consoleProjects.ts fileRpc).
// Through the plain `rpc` the Console refuses `openLocalFile` outright, and every click toasted
// "needs a project on the Console".
test("on the Console, Open asks the project whose directory holds the file", async () => {
  const { openOutsideFrizz } = await import("./MarkdownDrawer.tsx")
  const { setFileProjects } = await import("../lib/consoleProjects.ts")
  const { store } = await import("../store.ts")
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location")
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { pathname: "/console", origin: "http://frizz.test" } })
  const sent: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    sent.push(String(url))
    return new Response(JSON.stringify({ result: { action: "opened", path: "/w/billing/README.md" } }), { status: 200 })
  }) as typeof fetch
  setFileProjects([{ slug: "acme-web", path: "/w/acme-web" }, { slug: "billing", path: "/w/billing" }])
  store.toast = null
  try {
    await openOutsideFrizz("/w/billing/README.md")
    assert.deepEqual(sent, ["/_frizz/billing/rpc/openLocalFile"])
    assert.equal(store.toast, null, "no failure toast")
  } finally {
    setFileProjects([])
    globalThis.fetch = previousFetch
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation)
    else Reflect.deleteProperty(globalThis, "location")
  }
})
