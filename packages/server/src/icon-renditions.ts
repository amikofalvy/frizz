import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { frizzPaths } from "./frizz-paths.ts"
import { decodeRaster, encodePng, rasterDimensions, resizeToFit, type Raster } from "./raster.ts"

// SHRUNKEN COPIES OF EACH PROJECT ICON, made once per size and kept on disk.
//
// A square is drawn at 14px (a thread header), 16px (the Console), 34px (the grid) and 40px (the
// rail) — 28 to 80 device pixels on a 2x screen — and the icon a scan finds is routinely 512. The
// square asks for its EXACT device-pixel size (`&s=`, see ProjectSquare) and this answers with a PNG
// that size instead of the original.
//
// EXACT, not a ladder of fixed sizes. A 96px copy drawn into an 80px square is resampled a second time
// by the browser, and that second pass visibly softened totheright's pixel-art `icon-128.png` next to
// the original (compared 2026-10-21); an 80px copy drawn at 80 is copied pixel for pixel. The sizes
// in use are few (four squares at the screen's density), so the cache stays small.
//
// MADE ON THE FIRST REQUEST FOR EACH SIZE. The files are CONTENT-ADDRESSED (the original's hash is in
// the name), so a changed icon can never be answered with a stale copy, and the cache needs no
// invalidation beyond deleting what an older icon left behind. It lives under Frizz's cache root
// because every byte of it can be regenerated.

/** Bump to regenerate every rendition on the machine — a better filter, a different encoding. */
export const RENDITION_VERSION = 1

/** The largest copy kept. Beyond it — a 40px square at 7x — the original is served. */
export const MAX_RENDITION_PX = 256

/** `<cache>/project-icons/<id>/` — one project's renditions. */
export function iconRenditionDir(id: string, home = homedir()): string {
  return join(frizzPaths({ home }).cache, "project-icons", id)
}

function renditionName(hash: string, size: number): string {
  return `${hash}-${size}.v${RENDITION_VERSION}.png`
}

/**
 * The decoded icon, for the last few icons asked about.
 *
 * Opening the grid asks for 68 device px and the rail beside it for 80, so one icon wants two sizes
 * within milliseconds of each other. Keeping its pixels makes the second one shrink instead of a
 * second decode — which for an upload near the 4096px cap is a second of the server's time. Kept at
 * most 1024px (4 MB), so eight of them are bounded, and anything up to that size is shrunk straight
 * from its own pixels, which is the sharpest copy there is.
 */
const decoded = new Map<string, Raster>()
const DECODED_KEPT = 8
const DECODED_MAX_PX = 1024

function masterFor(hash: string, bytes: Uint8Array): Raster | undefined {
  const kept = decoded.get(hash)
  if (kept) return kept
  const image = decodeRaster(bytes)
  if (!image) return undefined
  const master = resizeToFit(image, DECODED_MAX_PX)
  decoded.set(hash, master)
  if (decoded.size > DECODED_KEPT) decoded.delete(decoded.keys().next().value!)
  return master
}

/**
 * The `size`-pixel rendition of an icon whose bytes are `bytes` and whose `iconContentHash` is
 * `hash`, or undefined when the ORIGINAL is the right thing to serve: a format this cannot decode
 * (SVG, JPEG, WebP, GIF), an original no bigger than `size`, or a size out of range.
 */
export function projectIconRendition(
  id: string,
  bytes: Uint8Array,
  hash: string,
  size: number,
  options: { home?: string } = {},
): Buffer | undefined {
  if (!Number.isInteger(size) || size < 1 || size > MAX_RENDITION_PX) return undefined
  // Read from the header alone, so an SVG or an already-small PNG is answered without a decode.
  const dimensions = rasterDimensions(bytes)
  if (!dimensions || Math.max(dimensions.width, dimensions.height) <= size) return undefined
  const dir = iconRenditionDir(id, options.home)
  const file = join(dir, renditionName(hash, size))
  try {
    return readFileSync(file)
  } catch {
    // Not made yet.
  }
  const master = masterFor(hash, bytes)
  if (!master) return undefined
  const png = encodePng(resizeToFit(master, size))
  try {
    mkdirSync(dir, { recursive: true })
    // An older icon's copies are dead: their hash is in no URL any card will hand out again.
    for (const name of readdirSync(dir)) if (!name.startsWith(`${hash}-`)) rmSync(join(dir, name), { force: true })
    // Renamed into place, so a concurrent reader sees the whole file or none of it.
    const partial = `${file}.${process.pid}.tmp`
    writeFileSync(partial, png)
    renameSync(partial, file)
  } catch {
    // A read-only or full cache: served from memory this once, and shrunk again next time.
  }
  return png
}
