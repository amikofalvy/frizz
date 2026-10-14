import assert from "node:assert/strict"
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { adhocFrizzRoot } from "./lib/adhoc-frizz-root.mjs"

test("a sandbox HOME keeps Frizz's state in its own .frizz", () => {
  assert.equal(adhocFrizzRoot({ home: "/tmp/frizz-adhoc-home-abc", realHome: "/Users/someone", legacyExists: false }), "sandbox")
  assert.equal(adhocFrizzRoot({ home: "/tmp/frizz-adhoc-home-abc", realHome: "/Users/someone", legacyExists: true }), "sandbox")
})

test("the real HOME is never given a .frizz it did not already have", () => {
  const home = mkdtempSync(join(tmpdir(), "adhoc-root-"))
  try {
    assert.equal(adhocFrizzRoot({ home, realHome: home, legacyExists: false }), "isolated")
    assert.equal(adhocFrizzRoot({ home, realHome: home, legacyExists: true }), "shared")
    // The same directory spelled another way is still the real HOME: `--home=$HOME/`, or through a link.
    assert.equal(adhocFrizzRoot({ home: `${home}/`, realHome: home, legacyExists: false }), "isolated")
    const link = join(home, "link")
    symlinkSync(home, link)
    assert.equal(adhocFrizzRoot({ home: link, realHome: home, legacyExists: false }), "isolated")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("with no HOME to compare against, the stack's HOME is treated as its own", () => {
  assert.equal(adhocFrizzRoot({ home: "/tmp/frizz-adhoc-home-abc", realHome: undefined, legacyExists: false }), "sandbox")
})
