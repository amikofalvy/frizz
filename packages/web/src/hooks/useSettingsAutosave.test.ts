import assert from "node:assert/strict"
import test from "node:test"
import { QueryClient } from "@tanstack/react-query"
import type { Settings } from "@frizz/shared"
import { projectScopedQueryKeyHash } from "../lib/queryKeyScope.ts"
import { settingsQuery, writeSettings } from "./useSettingsAutosave.tsx"

// WHOSE SETTINGS A SURFACE EDITS. The agent settings behind the prompt box's gear (permissions, the
// prompt cache tier, the compaction windows) are stored per project, and a dispatch runs under its own
// project's. On the Console the prompt box belongs to the project its chip names (ProjectScope), so its
// gear must read and write THAT project — it used to read and rewrite the launching project's, so the
// permission it showed was not the one the thread ran under, and a pick rewrote a stranger's settings.

async function onPage<T>(pathname: string, body: (sent: { method: string; path: string; body?: string }[]) => Promise<T>): Promise<T> {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location")
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { pathname, origin: "http://frizz.test" } })
  const sent: { method: string; path: string; body?: string }[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ method: init?.method ?? "GET", path: new URL(String(url), "http://frizz.test").pathname, body: init?.body as string | undefined })
    return new Response(JSON.stringify({ result: { permissionMode: "auto" } }), { status: 200 })
  }) as typeof fetch
  try {
    return await body(sent)
  } finally {
    globalThis.fetch = previousFetch
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation)
    else Reflect.deleteProperty(globalThis, "location")
  }
}

test("on the Console, a scoped surface reads and writes its own project's settings", async () => {
  await onPage("/console", async (sent) => {
    await settingsQuery("billing").queryFn()
    await writeSettings({ project: "billing", settings: { permissionMode: "auto" } as Settings })
    assert.deepEqual(sent.map((s) => `${s.method} ${s.path}`), ["GET /_frizz/billing/rpc/settingsGet", "POST /_frizz/billing/rpc/settingsSet"])
    assert.equal(JSON.parse(sent[1]!.body!).permissionMode, "auto")
  })
})

test("each project's settings are their own cache entry on the Console, and a page's own key is unchanged", () => {
  const qc = new QueryClient({ defaultOptions: { queries: { queryKeyHashFn: projectScopedQueryKeyHash } } })
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location")
  Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { pathname: "/console" } })
  try {
    qc.setQueryData(settingsQuery("billing").queryKey, { permissionMode: "bypassPermissions" })
    assert.equal(qc.getQueryData(settingsQuery("docs-site").queryKey), undefined, "docs-site must not read billing's settings")
    assert.equal(qc.getQueryData(settingsQuery(undefined).queryKey), undefined, "nor the launching project's")
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous)
    else Reflect.deleteProperty(globalThis, "location")
  }
  // Unscoped is the bare key every other reader of the page's settings shares (App's notifications
  // mirror, lib/projectRail.ts), so a save from the drawer still lands where they look.
  assert.deepEqual(settingsQuery(undefined).queryKey, ["settingsGet"])
})

test("with no scope the call is the page's, as before: the project page's own, or the launching project's on the Console", async () => {
  await onPage("/project/billing", async (sent) => {
    await settingsQuery(undefined).queryFn()
    assert.deepEqual(sent.map((s) => s.path), ["/_frizz/billing/rpc/settingsGet"])
  })
  // The Settings drawer edits only machine keys (notifications, the file opener, the rail), which any
  // project answers alike, so on the Console it stays where it was.
  await onPage("/console", async (sent) => {
    await settingsQuery(undefined).queryFn()
    assert.deepEqual(sent.map((s) => s.path), ["/_frizz/rpc/settingsGet"])
  })
})
