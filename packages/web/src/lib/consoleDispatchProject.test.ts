import assert from "node:assert/strict"
import test from "node:test"
import { consoleDispatchProject, pickConsoleDispatchProject } from "./consoleDispatchProject.ts"

// The Console's new-thread surfaces (the sidebar's prompt box, ⌘K's dialog, the phone's page) share one
// choice of project. ⌘K's dialog used to have none at all, so its dispatch was refused on the Console.

const projects = [{ slug: "acme-web" }, { slug: "billing" }, { slug: "docs-site" }]

test("the remembered project while it is open, else the first in the rail's order", () => {
  assert.equal(consoleDispatchProject(projects, "billing")?.slug, "billing")
  assert.equal(consoleDispatchProject(projects, "gone")?.slug, "acme-web", "a project no longer open falls back")
  assert.equal(consoleDispatchProject(projects, null)?.slug, "acme-web")
  assert.equal(consoleDispatchProject([], "billing"), undefined, "nothing open, nothing to dispatch to")
})

test("a pick is remembered across page loads", () => {
  const stored = new Map<string, string>()
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) },
  })
  try {
    pickConsoleDispatchProject("docs-site")
    assert.equal(stored.get("frizz:console-dispatch-project"), "docs-site")
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous)
    else Reflect.deleteProperty(globalThis, "localStorage")
  }
})
