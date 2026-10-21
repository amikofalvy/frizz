import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { brotliDecompressSync } from "node:zlib"
import { createApp } from "./app.ts"
import type { AppContext } from "./context.ts"
import { iconRenditionDir } from "./icon-renditions.ts"
import { detectProjectIcon } from "./project-icon.ts"
import { customIconPath, iconContentHash, readRegistry, registerProject, resolveProjectIcon, setProjectIcon } from "./project-registry.ts"
import { encodePng, rasterDimensions } from "./raster.ts"

// The icon route end to end: renditions, the content-hash version, and the caching headers that make a
// remounted or reloaded square draw from the browser's cache.

const A = "6f1e8b52-3c1d-4a39-9b9e-2f4c1c7d0a11"
const PORT = 49_183

/** A sandbox HOME the route reads: it resolves the registry and the cache from `homedir()`. */
function sandbox(t: { after: (fn: () => void) => void }): { home: string; dir: string } {
  const home = mkdtempSync(join(tmpdir(), "frizz-icon-route-"))
  mkdirSync(join(home, ".frizz"), { recursive: true })
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  t.after(() => {
    process.env.HOME = previous.HOME
    process.env.USERPROFILE = previous.USERPROFILE
    rmSync(home, { recursive: true, force: true })
  })
  const dir = join(home, "code", "app")
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  writeFileSync(join(dir, ".frizz", ".id"), `${A}\n`)
  registerProject({ dir, id: A }, home)
  return { home, dir }
}

/** A square PNG of `size`, its colour picked by `seed` so two of them never share a hash. */
function logo(size: number, seed = 0): Buffer {
  const rgba = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) rgba.set([(i + seed) % 256, (i >> 8) % 256, seed % 256, 255], i * 4)
  return encodePng({ width: size, height: size, rgba })
}

function app() {
  const inert = new Proxy({}, { get: () => () => {} })
  const ctx = {
    bootId: "icon-route-boot",
    project: { id: "icon-route-project", dir: "/tmp/icon-route-project", stateDir: "/tmp/icon-route-state", cwdSlug: "-tmp-icon-route-project", name: "icon-route", label: "local/icon-route" },
    bus: inert, transcriptChange: inert, storage: inert, interactions: inert, board: inert, tailer: inert,
    dispatcher: inert, backendFor: () => inert, scheduler: inert, permissionController: inert,
    getSettings: () => ({}), setSettings: (settings: unknown) => settings, resetSettings: () => ({}),
  } as unknown as AppContext
  const served = createApp(ctx, { port: PORT })
  return (query: string, headers: Record<string, string> = {}) =>
    served.request(`http://127.0.0.1:${PORT}/_frizz/project-icon?id=${A}${query}`, {
      headers: { host: `127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin", ...headers },
    })
}

test("a sized request for a big PNG gets a PNG exactly that size, made once and then read from the cache", async (t) => {
  const { home, dir } = sandbox(t)
  writeFileSync(join(dir, "logo.png"), logo(512))
  const get = app()

  // The rail's 40px square at 2x.
  const first = await get("&s=80")
  assert.equal(first.status, 200)
  assert.equal(first.headers.get("content-type"), "image/png")
  assert.deepEqual(rasterDimensions(Buffer.from(await first.arrayBuffer())), { width: 80, height: 80 })
  const hash = readRegistry(home).projects[0]!.iconHash!
  assert.deepEqual(readdirSync(iconRenditionDir(A, home)), [`${hash}-80.v1.png`])

  // The next request for that size is answered from the file, not by shrinking again.
  writeFileSync(join(iconRenditionDir(A, home), `${hash}-80.v1.png`), "from the cache")
  assert.equal(await (await get("&s=80")).text(), "from the cache")
  // And another size is its own copy beside it.
  assert.deepEqual(rasterDimensions(Buffer.from(await (await get("&s=28")).arrayBuffer())), { width: 28, height: 28 })
  assert.deepEqual(readdirSync(iconRenditionDir(A, home)).sort(), [`${hash}-28.v1.png`, `${hash}-80.v1.png`])
})

test("an icon the route cannot or need not shrink is served as it is", async (t) => {
  const { dir } = sandbox(t)
  const get = app()
  writeFileSync(join(dir, "logo.png"), logo(48))
  const small = await get("&s=96")
  assert.deepEqual(rasterDimensions(Buffer.from(await small.arrayBuffer())), { width: 48, height: 48 }, "never enlarged")
  writeFileSync(join(dir, "logo.png"), logo(512))
  // Past the largest copy kept, the original.
  assert.deepEqual(rasterDimensions(Buffer.from(await (await get("&s=300")).arrayBuffer())), { width: 512, height: 512 })
})

test("the URL version is the picture's hash, so it holds across rescans and moves when the picture does", async (t) => {
  const { home, dir } = sandbox(t)
  const file = join(dir, "logo.png")
  writeFileSync(file, logo(256, 1))
  const scannedAt = Date.parse("2026-10-21T09:00:00.000Z")
  resolveProjectIcon(A, (root) => detectProjectIcon(root)?.path, { home, now: () => scannedAt })
  const first = readRegistry(home).projects[0]!.iconHash
  assert.equal(first, iconContentHash(logo(256, 1)))

  // A rescan well after the window lands on the same file: the scan time moves, the version does not.
  resolveProjectIcon(A, (root) => detectProjectIcon(root)?.path, { home, now: () => scannedAt + 60 * 60 * 1000 })
  assert.equal(readRegistry(home).projects[0]!.iconHash, first)

  // The file edited in place, inside the window, so no rescan: the route notices from the bytes.
  writeFileSync(file, logo(256, 2))
  await app()("&s=64")
  assert.equal(readRegistry(home).projects[0]!.iconHash, iconContentHash(logo(256, 2)))
})

test("a current URL is served from the cache while it revalidates; a stale one, or a match, says so", async (t) => {
  const { home, dir } = sandbox(t)
  writeFileSync(join(dir, "logo.png"), logo(256))
  const get = app()
  const unversioned = await get("&s=64")
  assert.equal(unversioned.headers.get("cache-control"), "private, no-cache")
  const hash = readRegistry(home).projects[0]!.iconHash!

  const current = await get(`&v=${hash}&s=64`)
  assert.equal(current.headers.get("cache-control"), "private, max-age=300, stale-while-revalidate=2592000")
  const etag = current.headers.get("etag")!
  assert.equal(etag, `W/"${hash}-64.v1"`)
  assert.equal((await get(`&v=old&s=64`)).headers.get("cache-control"), "private, no-cache", "a version that is not the current picture")

  const revalidated = await get(`&v=${hash}&s=64`, { "if-none-match": etag })
  assert.equal(revalidated.status, 304)
  assert.equal(revalidated.headers.get("cache-control"), "private, max-age=300, stale-while-revalidate=2592000")
  assert.equal((await get(`&v=${hash}&s=96`, { "if-none-match": etag })).status, 200, "another size is other bytes")
})

test("an SVG is served whole, compressed for a client that accepts it", async (t) => {
  const { dir } = sandbox(t)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${'<rect width="8" height="8" fill="#e4572e"/>'.repeat(60)}</svg>`
  writeFileSync(join(dir, "logo.svg"), svg)
  const response = await app()("&s=96", { "accept-encoding": "br, gzip" })
  assert.equal(response.headers.get("content-type"), "image/svg+xml")
  assert.equal(response.headers.get("content-encoding"), "br")
  assert.equal(brotliDecompressSync(Buffer.from(await response.arrayBuffer())).toString(), svg)
})

test("a new icon replaces the old one's renditions rather than piling up beside them", async (t) => {
  const { home, dir } = sandbox(t)
  writeFileSync(join(dir, "logo.png"), logo(256, 1))
  const get = app()
  await get("&s=64")
  const upload = customIconPath(A, ".png", home)
  mkdirSync(dirname(upload), { recursive: true })
  writeFileSync(upload, logo(256, 2))
  setProjectIcon(A, upload, home)
  await get("&s=64")
  const hash = iconContentHash(logo(256, 2))
  assert.deepEqual(readdirSync(iconRenditionDir(A, home)), [`${hash}-64.v1.png`])
})
