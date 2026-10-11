import { test } from "node:test"
import assert from "node:assert/strict"
import { parseStandaloneThreadPath, standaloneThreadHref } from "./standaloneThreadRoute.ts"
import { innerPath } from "./base-path.ts"

test("standalone thread links encode slugs and round-trip through the parser", () => {
  const href = standaloneThreadHref("fix queue/spacing")
  assert.equal(href, "/thread/fix%20queue%2Fspacing/full")
  assert.equal(parseStandaloneThreadPath(href), "fix queue/spacing")
})

test("a standalone thread link carries the project prefix of the page it is minted on", () => {
  // The ↗ button on a thread in a non-launching project. Without the prefix this addresses whichever
  // project launched the server — a different thread, or none.
  const href = standaloneThreadHref("fix-auth", "/project/nub/thread/fix-auth")
  assert.equal(href, "/project/nub/thread/fix-auth/full")
  // …and the router still reasons about the INNER path, so the round-trip holds under a prefix too.
  assert.equal(parseStandaloneThreadPath(innerPath(href)), "fix-auth")
  // The launching project is served at the root; an unprefixed page still mints an unprefixed link.
  assert.equal(standaloneThreadHref("fix-auth", "/thread/fix-auth"), "/thread/fix-auth/full")
})

test("standalone parsing rejects drawer, extra-segment, and malformed routes", () => {
  assert.equal(parseStandaloneThreadPath("/thread/example"), null)
  assert.equal(parseStandaloneThreadPath("/thread/example/full/more"), null)
  assert.equal(parseStandaloneThreadPath("/thread/%/full"), null)
})

test("a Console thread's full page is its own project's, under its real slug", () => {
  // The Console names a thread by key (lib/threadKey.ts); `/console/thread/<key>/full` is no route.
  assert.equal(standaloneThreadHref("billing~retry-webhooks", "/console"), "/project/billing/thread/retry-webhooks/full")
  assert.equal(standaloneThreadHref("billing~retry-webhooks", "/project/nub"), "/project/billing/thread/retry-webhooks/full")
})
