import assert from "node:assert/strict"
import { test } from "node:test"
import { bareSlug, keyProject, splitThreadKey, threadKey } from "./threadKey.ts"

test("a key round-trips its project and slug", () => {
  const key = threadKey("pullfrog-app", "fix-auth-2")
  assert.equal(key, "pullfrog-app~fix-auth-2")
  assert.deepEqual(splitThreadKey(key), { project: "pullfrog-app", slug: "fix-auth-2" })
  assert.equal(bareSlug(key), "fix-auth-2")
  assert.equal(keyProject(key), "pullfrog-app")
})

test("a plain slug is not a key", () => {
  for (const slug of ["fix-auth", "a", "~", "nub~", "~fix"]) {
    assert.equal(splitThreadKey(slug), null, slug)
    assert.equal(bareSlug(slug), slug, slug)
    assert.equal(keyProject(slug), undefined, slug)
  }
})
