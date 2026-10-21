import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { deflateSync } from "node:zlib"
import { decodeRaster, encodePng, rasterDimensions, resizeToFit, type Raster } from "./raster.ts"

// These pin the codec's contract on images whose pixels are known by construction. Its agreement
// with a real decoder was measured separately (2026-10-21): 141 PNG and ICO files from this machine
// and 156 generated PNGs over every colour type, bit depth, tRNS and interlace decoded to Chrome's
// own pixels, and a decoder broken on purpose failed all 156.

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function chunk(type: string, body: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body])
  let c = 0xffffffff
  for (const byte of typed) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8)
  const out = Buffer.alloc(12 + body.length)
  out.writeUInt32BE(body.length, 0)
  typed.copy(out, 4)
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + body.length)
  return out
}

/** A PNG from already-packed rows, each written with filter 0, plus any extra chunks before IDAT. */
function png(width: number, height: number, depth: number, colorType: number, rows: number[][], extra: Buffer[] = [], interlace = 0): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = depth
  header[9] = colorType
  header[12] = interlace
  const raw = Buffer.concat(rows.map((row) => Buffer.from([0, ...row])))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...extra,
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const pixels = (image: Raster | undefined) => image && [...image.rgba]

test("every PNG colour type decodes to straight RGBA", () => {
  // Grey, 8-bit, with the tRNS key 0x40 marking the second pixel transparent.
  assert.deepEqual(pixels(decodeRaster(png(2, 1, 8, 0, [[0x10, 0x40]], [chunk("tRNS", Buffer.from([0, 0x40]))]))), [0x10, 0x10, 0x10, 255, 0x40, 0x40, 0x40, 0])
  // Grey, 2-bit: samples 0..3 spread over 0..255.
  assert.deepEqual(pixels(decodeRaster(png(4, 1, 2, 0, [[0b00011011]]))), [0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 255, 255, 255, 255, 255])
  // RGB, 16-bit: the high byte of each sample.
  assert.deepEqual(pixels(decodeRaster(png(1, 1, 16, 2, [[0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]]))), [0x12, 0x56, 0x9a, 255])
  // Palette, 4-bit, with a tRNS shorter than the palette: index 1 is half transparent, index 2 opaque.
  const palette = chunk("PLTE", Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0]))
  assert.deepEqual(pixels(decodeRaster(png(2, 1, 4, 3, [[0x12]], [palette, chunk("tRNS", Buffer.from([255, 128]))]))), [255, 0, 0, 128, 0, 255, 0, 255])
  // Grey + alpha, 8-bit.
  assert.deepEqual(pixels(decodeRaster(png(1, 1, 8, 4, [[200, 100]]))), [200, 200, 200, 100])
  // RGBA, 8-bit.
  assert.deepEqual(pixels(decodeRaster(png(1, 1, 8, 6, [[1, 2, 3, 4]]))), [1, 2, 3, 4])
})

test("an Adam7-interlaced PNG lands every pass's pixels where they belong", () => {
  // 3×3 grey: passes 1 (0,0), 4 (2,0), 5 (0,2)+(2,2), 6 (1,0)… — written out pass by pass, each pixel's
  // value being its own position, so a misplaced one cannot go unnoticed.
  const value = (x: number, y: number) => y * 3 + x + 1
  const passes: [number, number, number, number][] = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
  const rows: number[][] = []
  for (const [x0, y0, dx, dy] of passes) {
    for (let y = y0; y < 3; y += dy) {
      const row: number[] = []
      for (let x = x0; x < 3; x += dx) row.push(value(x, y))
      if (row.length) rows.push(row)
    }
  }
  const decoded = decodeRaster(png(3, 3, 8, 0, rows, [], 1))!
  assert.deepEqual([...decoded.rgba].filter((_, i) => i % 4 === 0), [1, 2, 3, 4, 5, 6, 7, 8, 9])
})

test("this repo's own 512px icon decodes, and what encodePng writes decodes back to the same pixels", () => {
  const original = decodeRaster(readFileSync(new URL("../../web/public/icon-512.png", import.meta.url)))!
  assert.equal(original.width, 512)
  assert.equal(original.height, 512)
  const small = resizeToFit(original, 64)
  assert.deepEqual(pixels(decodeRaster(encodePng(small))), pixels(small))
})

test("an ICO answers with its LARGEST entry, PNG or bitmap", () => {
  const entry = (width: number, bits: number, data: Buffer, offset: number) => {
    const e = Buffer.alloc(16)
    e[0] = width
    e[1] = width
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(bits, 6)
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    return e
  }
  // A 2×2 24-bit bitmap, bottom row first, BGR, rows padded to 4 bytes, then its 1-bit AND mask: the
  // top-left pixel is masked out.
  const bmpHeader = Buffer.alloc(40)
  bmpHeader.writeUInt32LE(40, 0)
  bmpHeader.writeInt32LE(2, 4)
  bmpHeader.writeInt32LE(4, 8)
  bmpHeader.writeUInt16LE(1, 12)
  bmpHeader.writeUInt16LE(24, 14)
  const bottom = [0, 0, 255, 0, 255, 0, 0, 0] // red, green, padding
  const top = [255, 0, 0, 255, 255, 255, 0, 0] // blue, white, padding
  const mask = [0, 0, 0, 0, 0b10000000, 0, 0, 0] // bottom row clear, top row's first pixel set
  const bitmap = Buffer.concat([bmpHeader, Buffer.from([...bottom, ...top, ...mask])])
  const small = png(1, 1, 8, 6, [[9, 9, 9, 255]])
  const header = Buffer.from([0, 0, 1, 0, 2, 0])
  const ico = (first: Buffer, second: Buffer) => Buffer.concat([header, entry(1, 32, first, 38), entry(2, 24, second, 38 + first.length), first, second])
  assert.deepEqual(pixels(decodeRaster(ico(small, bitmap))), [0, 0, 255, 0, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255])
  assert.deepEqual(rasterDimensions(ico(small, bitmap)), { width: 2, height: 2 })
})

test("formats it does not decode, and broken files, come back undefined rather than throwing", () => {
  assert.equal(decodeRaster(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"/>`)), undefined)
  assert.equal(decodeRaster(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), undefined)
  const whole = png(1, 1, 8, 6, [[1, 2, 3, 4]])
  assert.equal(decodeRaster(whole.subarray(0, whole.length - 20)), undefined)
  assert.equal(rasterDimensions(Buffer.from("GIF89a")), undefined)
})

test("resizeToFit keeps proportions and never enlarges", () => {
  const image = (width: number, height: number): Raster => ({ width, height, rgba: new Uint8Array(width * height * 4).fill(255) })
  const logo = resizeToFit(image(300, 331), 128)
  assert.deepEqual([logo.width, logo.height], [116, 128])
  const tiny = image(16, 16)
  assert.equal(resizeToFit(tiny, 32), tiny)
})

test("resizeToFit averages LIGHT, and does not let transparent pixels darken an edge", () => {
  // Black beside white averages to the sRGB value of half the light (188), not to 128, which is what
  // averaging the stored numbers gives and what dims every thin bright stroke on a small icon.
  const checker: Raster = { width: 2, height: 1, rgba: Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255]) }
  assert.deepEqual(pixels(resizeToFit(checker, 1)), [188, 188, 188, 255])
  // Opaque red beside fully transparent BLACK: half-covered red, not half-covered dark red.
  const edge: Raster = { width: 2, height: 1, rgba: Uint8Array.from([255, 0, 0, 255, 0, 0, 0, 0]) }
  assert.deepEqual(pixels(resizeToFit(edge, 1)), [255, 0, 0, 128])
})
