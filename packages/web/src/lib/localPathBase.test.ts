import assert from "node:assert/strict"
import test from "node:test"
import { localPathBase, localPathBaseFor, projectPathDir, setLocalPathBase, setProjectPathBases, subscribeLocalPathBase } from "./localPathBase.ts"

// Review finding 4 (2026-10-11): on the Console the page base is empty (the merged board is refused at
// store.ts's door, and the binding's reset clears it), so every relative or `~/` Markdown link and image in
// a Console card stayed relative — a junk new tab, a dropped image. A surface on the Console resolves
// against ITS project's directory (its ProjectScope) and the machine's home.
test("a Console surface resolves against its own project's directory and the home", () => {
  setLocalPathBase(null)
  setProjectPathBases([["acme", "/code/acme"], ["billing", "/code/billing"]], "/Users/me")
  try {
    assert.deepEqual(localPathBaseFor("billing"), { dir: "/code/billing", home: "/Users/me" })
    assert.deepEqual(localPathBaseFor("acme"), { dir: "/code/acme", home: "/Users/me" })
    assert.equal(projectPathDir("billing"), "/code/billing")
    // A stable identity per project, or useSyncExternalStore re-renders forever.
    assert.equal(localPathBaseFor("billing"), localPathBaseFor("billing"))
    // No project of its own (the Markdown reader names its own directory): `~` still expands.
    assert.deepEqual(localPathBaseFor(undefined), { dir: "", home: "/Users/me" })
    // A project the Console does not know: the page's base, never a guess.
    assert.equal(localPathBaseFor("gone"), localPathBaseFor(undefined))
    assert.equal(projectPathDir("gone"), "")
  } finally {
    setProjectPathBases([], "")
  }
})

test("off the Console every surface reads the page's base", () => {
  setLocalPathBase("/code/nub", "/Users/me")
  try {
    assert.equal(localPathBaseFor(undefined), localPathBase())
    assert.equal(localPathBaseFor("billing"), localPathBase(), "no Console projects registered")
    // A project page with Console projects still registered (a stale map) keeps its own base unscoped.
    setProjectPathBases([["billing", "/code/billing"]], "/Users/me")
    assert.equal(localPathBaseFor(undefined), localPathBase())
  } finally {
    setProjectPathBases([], "")
    setLocalPathBase(null)
  }
})

test("registering the same projects again notifies nobody", () => {
  let calls = 0
  const off = subscribeLocalPathBase(() => { calls += 1 })
  try {
    setProjectPathBases([["a", "/a"]], "/h")
    setProjectPathBases([["a", "/a"]], "/h")
    assert.equal(calls, 1)
    setProjectPathBases([["a", "/a2"]], "/h")
    assert.equal(calls, 2)
  } finally {
    off()
    setProjectPathBases([], "")
  }
})
