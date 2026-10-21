import { deflateSync, inflateSync } from "node:zlib"

// SMALL RASTER CODECS FOR PROJECT ICONS — decode PNG and ICO, shrink, encode PNG. No dependency.
//
// A project icon is drawn at 14 to 40 CSS px, and what the scan finds is routinely a 512px
// `icon-512.png` (80 KB for this repo's own) or a multi-resolution `favicon.ico`. Serving that
// original to every square is the bytes and the decode of a picture fifty times the area it fills,
// on every cold load and over every tunnel. `icon-renditions.ts` keeps shrunken copies; this file is
// the pixels.
//
// WHY HAND-WRITTEN rather than sharp or a WASM codec: frizz-server ships as one esbuild bundle with a
// single native dependency, and a native image library is the kind of install that has broken Frizz
// on Linux before (node-pty, AGENTS.md § There is NO pty). PNG is zlib plus row filters, which node
// already has, and an ICO is a directory of PNGs or uncompressed bitmaps. Those two cover what icon
// toolchains emit. SVG needs no rendition (it is vector, and the browser rasterizes it at whatever
// size it is drawn), and JPEG, WebP and GIF are left as they are — `decodeRaster` answers undefined
// and the original is served.

export interface Raster {
  width: number
  height: number
  /** Straight (not premultiplied) RGBA, 8 bits per channel, rows top to bottom. */
  rgba: Uint8Array
}

/**
 * The largest picture this will decode: 4096×4096. Decoding allocates the whole image (64 MB at the
 * cap), and an icon has no business being bigger, so anything larger keeps its original.
 */
export const MAX_DECODE_PIXELS = 4096 * 4096

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Decode a PNG or an ICO, by magic bytes. Undefined for any other format, or for a broken file. */
export function decodeRaster(bytes: Uint8Array): Raster | undefined {
  try {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return decodePng(buffer)
    if (buffer.length >= 6 && buffer.readUInt16LE(0) === 0 && buffer.readUInt16LE(2) === 1) return decodeIco(buffer)
    return undefined
  } catch {
    // A truncated IDAT, a chunk length past the end, a bitmap shorter than its header promises: all of
    // them mean "serve the original", never a failed request.
    return undefined
  }
}

/**
 * A PNG's or an ICO's size from its header alone — the IHDR, or the ICO's largest directory entry —
 * so the caller can tell an image that needs no shrinking without decoding it. Undefined for every
 * other format.
 */
export function rasterDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length < 22 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) return undefined
  let best: { width: number; height: number } | undefined
  for (let i = 0; i < buffer.readUInt16LE(4) && 6 + i * 16 + 16 <= buffer.length; i++) {
    const width = buffer[6 + i * 16] || 256
    const height = buffer[7 + i * 16] || 256
    if (!best || width * height > best.width * best.height) best = { width, height }
  }
  return best
}

// ── PNG ────────────────────────────────────────────────────────────────────────────────────────────

/** Channels per pixel, by PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** Adam7: each pass's starting column and row, and its column and row step. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const

/**
 * Every colour type and bit depth the format allows, palette transparency and Adam7 interlacing
 * included. Colour management is not applied — a `gAMA` or `iCCP` chunk is ignored — which is what
 * a 64px icon can afford; an APNG decodes as its default (first) image.
 */
export function decodePng(buffer: Buffer): Raster | undefined {
  let at = 8
  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let interlace = 0
  let palette: Buffer | undefined
  let transparency: Buffer | undefined
  const data: Buffer[] = []
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString("latin1", at + 4, at + 8)
    const body = buffer.subarray(at + 8, at + 8 + length)
    if (body.length !== length) return undefined
    if (type === "IHDR") {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      depth = body[8]!
      colorType = body[9]!
      interlace = body[12]!
    } else if (type === "PLTE") palette = body
    else if (type === "tRNS") transparency = body
    else if (type === "IDAT") data.push(body)
    else if (type === "IEND") break
    at += 12 + length
  }
  const channels = CHANNELS[colorType]
  if (!channels || width === 0 || height === 0 || width * height > MAX_DECODE_PIXELS || data.length === 0) return undefined
  if (colorType === 3 && !palette) return undefined
  const raw = inflateSync(Buffer.concat(data))
  const rgba = new Uint8Array(width * height * 4)
  const bitsPerPixel = channels * depth
  // The filter's "corresponding byte to the left": a whole pixel back, or one byte when pixels are
  // smaller than a byte.
  const filterStride = Math.max(1, bitsPerPixel >> 3)
  let offset = 0
  const passes = interlace === 1 ? ADAM7 : ([[0, 0, 1, 1]] as const)
  for (const [x0, y0, dx, dy] of passes) {
    const passWidth = Math.ceil((width - x0) / dx)
    const passHeight = Math.ceil((height - y0) / dy)
    if (passWidth <= 0 || passHeight <= 0) continue
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8)
    let previous = new Uint8Array(rowBytes)
    for (let row = 0; row < passHeight; row++) {
      const filter = raw[offset]
      const line = raw.subarray(offset + 1, offset + 1 + rowBytes)
      if (filter === undefined || line.length !== rowBytes) return undefined
      const current = new Uint8Array(line)
      unfilter(filter, current, previous, filterStride)
      offset += 1 + rowBytes
      for (let column = 0; column < passWidth; column++) {
        const target = ((y0 + row * dy) * width + x0 + column * dx) * 4
        writePixel(rgba, target, current, column, colorType, depth, palette, transparency)
      }
      previous = current
    }
  }
  return { width, height, rgba }
}

function unfilter(filter: number, line: Uint8Array, above: Uint8Array, stride: number): void {
  const n = line.length
  switch (filter) {
    case 0:
      return
    case 1:
      for (let i = stride; i < n; i++) line[i] = (line[i]! + line[i - stride]!) & 0xff
      return
    case 2:
      for (let i = 0; i < n; i++) line[i] = (line[i]! + above[i]!) & 0xff
      return
    case 3:
      for (let i = 0; i < n; i++) line[i] = (line[i]! + (((i >= stride ? line[i - stride]! : 0) + above[i]!) >> 1)) & 0xff
      return
    case 4:
      for (let i = 0; i < n; i++) {
        const left = i >= stride ? line[i - stride]! : 0
        const upperLeft = i >= stride ? above[i - stride]! : 0
        line[i] = (line[i]! + paeth(left, above[i]!, upperLeft)) & 0xff
      }
      return
    default:
      throw new Error(`unknown PNG filter ${filter}`)
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Sample `index` of a row at `depth` bits — a whole byte, two bytes, or a packed sub-byte field. */
function sample(line: Uint8Array, index: number, depth: number): number {
  if (depth === 8) return line[index]!
  if (depth === 16) return (line[index * 2]! << 8) | line[index * 2 + 1]!
  const perByte = 8 / depth
  const byte = line[Math.floor(index / perByte)]!
  const shift = 8 - depth * ((index % perByte) + 1)
  return (byte >> shift) & ((1 << depth) - 1)
}

function writePixel(
  out: Uint8Array,
  at: number,
  line: Uint8Array,
  column: number,
  colorType: number,
  depth: number,
  palette: Buffer | undefined,
  transparency: Buffer | undefined,
): void {
  // Any depth to 8 bits: a 16-bit sample keeps its high byte, a 1/2/4-bit grey is spread over 0–255.
  const max = (1 << depth) - 1
  const to8 = (value: number) => (depth === 16 ? value >> 8 : depth === 8 ? value : Math.round((value * 255) / max))
  if (colorType === 3) {
    const index = sample(line, column, depth)
    out[at] = palette![index * 3] ?? 0
    out[at + 1] = palette![index * 3 + 1] ?? 0
    out[at + 2] = palette![index * 3 + 2] ?? 0
    out[at + 3] = transparency && index < transparency.length ? transparency[index]! : 255
    return
  }
  if (colorType === 0 || colorType === 4) {
    const grey = sample(line, column * (colorType === 4 ? 2 : 1), depth)
    out[at] = out[at + 1] = out[at + 2] = to8(grey)
    if (colorType === 4) out[at + 3] = to8(sample(line, column * 2 + 1, depth))
    // A grey image's tRNS is the one exact sample value that means "transparent", at full depth.
    else out[at + 3] = transparency && transparency.length >= 2 && transparency.readUInt16BE(0) === grey ? 0 : 255
    return
  }
  const per = colorType === 6 ? 4 : 3
  const r = sample(line, column * per, depth)
  const g = sample(line, column * per + 1, depth)
  const b = sample(line, column * per + 2, depth)
  out[at] = to8(r)
  out[at + 1] = to8(g)
  out[at + 2] = to8(b)
  if (colorType === 6) out[at + 3] = to8(sample(line, column * 4 + 3, depth))
  else {
    const keyed = transparency && transparency.length >= 6 &&
      transparency.readUInt16BE(0) === r && transparency.readUInt16BE(2) === g && transparency.readUInt16BE(4) === b
    out[at + 3] = keyed ? 0 : 255
  }
}

// ── ICO ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The LARGEST entry of an icon file, whichever of its two encodings that entry uses: a whole PNG
 * (what every 256px entry is), or a headerless BMP — the colour bitmap stacked on a 1-bit AND mask,
 * bottom row first, which is what the 16/32/48px entries of a classic `favicon.ico` are.
 */
export function decodeIco(buffer: Buffer): Raster | undefined {
  const count = buffer.readUInt16LE(4)
  let best: { area: number; bits: number; offset: number; size: number } | undefined
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16
    if (at + 16 > buffer.length) break
    // One byte each, so 256 is written as 0.
    const area = (buffer[at] || 256) * (buffer[at + 1] || 256)
    const bits = buffer.readUInt16LE(at + 6)
    if (!best || area > best.area || (area === best.area && bits > best.bits)) {
      best = { area, bits, size: buffer.readUInt32LE(at + 8), offset: buffer.readUInt32LE(at + 12) }
    }
  }
  if (!best) return undefined
  const entry = buffer.subarray(best.offset, best.offset + best.size)
  if (entry.subarray(0, 8).equals(PNG_SIGNATURE)) return decodePng(entry)
  return decodeIcoBitmap(entry)
}

function decodeIcoBitmap(entry: Buffer): Raster | undefined {
  const headerSize = entry.readUInt32LE(0)
  const width = entry.readInt32LE(4)
  // The stated height covers the colour bitmap AND the mask beneath it, so the picture is half.
  const height = entry.readInt32LE(8) / 2
  const bits = entry.readUInt16LE(14)
  const compression = entry.readUInt32LE(16)
  if (width <= 0 || height <= 0 || width * height > MAX_DECODE_PIXELS || ![1, 4, 8, 24, 32].includes(bits)) return undefined
  // BI_RGB, or BI_BITFIELDS on a 32-bit entry, which in practice is always the standard BGRA order.
  if (compression !== 0 && !(compression === 3 && bits === 32)) return undefined
  const colorsUsed = entry.readUInt32LE(32)
  const paletteEntries = bits <= 8 ? colorsUsed || 1 << bits : 0
  // A plain 40-byte header is followed by its three BITFIELDS masks; the V4 and V5 headers hold them.
  const paletteAt = headerSize + (compression === 3 && headerSize === 40 ? 12 : 0)
  const pixelsAt = paletteAt + paletteEntries * 4
  const stride = Math.ceil((width * bits) / 32) * 4
  const maskAt = pixelsAt + stride * height
  const maskStride = Math.ceil(width / 32) * 4
  const hasMask = entry.length >= maskAt + maskStride * height
  if (entry.length < maskAt) return undefined
  const rgba = new Uint8Array(width * height * 4)
  let anyAlpha = false
  for (let y = 0; y < height; y++) {
    const row = pixelsAt + (height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4
      if (bits === 32 || bits === 24) {
        const at = row + x * (bits / 8)
        rgba[out] = entry[at + 2]!
        rgba[out + 1] = entry[at + 1]!
        rgba[out + 2] = entry[at]!
        rgba[out + 3] = bits === 32 ? entry[at + 3]! : 255
        if (bits === 32 && entry[at + 3]! > 0) anyAlpha = true
      } else {
        const index = sample(entry.subarray(row, row + stride), x, bits)
        const color = paletteAt + index * 4
        rgba[out] = entry[color + 2] ?? 0
        rgba[out + 1] = entry[color + 1] ?? 0
        rgba[out + 2] = entry[color] ?? 0
        rgba[out + 3] = 255
      }
    }
  }
  // A 32-bit entry with a real alpha channel ignores its mask. Everything else — and a 32-bit entry
  // whose alpha is all zero, which older tools wrote — takes its transparency from the mask.
  if (!anyAlpha && hasMask) {
    for (let y = 0; y < height; y++) {
      const row = maskAt + (height - 1 - y) * maskStride
      for (let x = 0; x < width; x++) {
        const transparent = (entry[row + (x >> 3)]! >> (7 - (x & 7))) & 1
        rgba[(y * width + x) * 4 + 3] = transparent ? 0 : 255
      }
    }
  }
  return { width, height, rgba }
}

// ── Resize ─────────────────────────────────────────────────────────────────────────────────────────

const TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})

function toSrgb8(linear: number): number {
  const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(c * 255)))
}

/** Per destination column (or row): the first source index it covers, and each one's share of it. */
function coverage(source: number, target: number): { start: number; weights: Float32Array }[] {
  const scale = source / target
  return Array.from({ length: target }, (_, i) => {
    const from = i * scale
    const to = Math.min(source, (i + 1) * scale)
    const start = Math.floor(from)
    const end = Math.ceil(to)
    const weights = new Float32Array(end - start)
    for (let j = start; j < end; j++) weights[j - start] = (Math.min(to, j + 1) - Math.max(from, j)) / scale
    return { start, weights }
  })
}

/**
 * Shrink `image` to fit inside `size`×`size`, keeping its proportions. Never enlarges: an image
 * already that small comes back as it is.
 *
 * Box-filter AREA AVERAGING — each output pixel is the exact mean of the source area it covers — in
 * LINEAR light and with PREMULTIPLIED alpha. Both matter at icon sizes. Averaging the stored sRGB
 * values darkens every edge between two colours, and a thin bright stroke on a dark mark visibly
 * dims; averaging straight alpha lets the colour of fully transparent pixels (often black) bleed
 * into the edge as a dark fringe. It is what a browser's high-quality downscale does, so a rendition
 * looks like the original drawn small, which is the whole requirement.
 *
 * Separable, so the cost is one pass over the source and one over a band `size` wide.
 */
export function resizeToFit(image: Raster, size: number): Raster {
  const longest = Math.max(image.width, image.height)
  if (longest <= size) return image
  const width = Math.max(1, Math.round((image.width * size) / longest))
  const height = Math.max(1, Math.round((image.height * size) / longest))
  const columns = coverage(image.width, width)
  const rows = coverage(image.height, height)
  // Horizontal pass: every source row, shrunk to `width` premultiplied linear pixels.
  const band = new Float32Array(width * image.height * 4)
  const src = image.rgba
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < width; x++) {
      const { start, weights } = columns[x]!
      let r = 0, g = 0, b = 0, a = 0
      for (let k = 0; k < weights.length; k++) {
        const at = (y * image.width + start + k) * 4
        const alpha = (src[at + 3]! / 255) * weights[k]!
        r += TO_LINEAR[src[at]!]! * alpha
        g += TO_LINEAR[src[at + 1]!]! * alpha
        b += TO_LINEAR[src[at + 2]!]! * alpha
        a += alpha
      }
      const out = (y * width + x) * 4
      band[out] = r
      band[out + 1] = g
      band[out + 2] = b
      band[out + 3] = a
    }
  }
  // Vertical pass, then back to straight sRGB.
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const { start, weights } = rows[y]!
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let k = 0; k < weights.length; k++) {
        const at = ((start + k) * width + x) * 4
        const weight = weights[k]!
        r += band[at]! * weight
        g += band[at + 1]! * weight
        b += band[at + 2]! * weight
        a += band[at + 3]! * weight
      }
      const out = (y * width + x) * 4
      if (a > 0) {
        rgba[out] = toSrgb8(r / a)
        rgba[out + 1] = toSrgb8(g / a)
        rgba[out + 2] = toSrgb8(b / a)
      }
      rgba[out + 3] = Math.max(0, Math.min(255, Math.round(a * 255)))
    }
  }
  return { width, height, rgba }
}

// ── PNG encode ─────────────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.length)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, "latin1")
  out.set(body, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
  return out
}

/**
 * An 8-bit RGBA PNG. Each row takes whichever of the five filters leaves the smallest sum of
 * absolute byte values — the standard heuristic, and at 128px it costs nothing.
 */
export function encodePng(image: Raster): Buffer {
  const { width, height, rgba } = image
  const rowBytes = width * 4
  const filtered = Buffer.alloc((rowBytes + 1) * height)
  const candidate = new Uint8Array(rowBytes)
  const best = new Uint8Array(rowBytes)
  for (let y = 0; y < height; y++) {
    const line = rgba.subarray(y * rowBytes, (y + 1) * rowBytes)
    const above = y > 0 ? rgba.subarray((y - 1) * rowBytes, y * rowBytes) : new Uint8Array(rowBytes)
    let bestFilter = 0
    let bestScore = Infinity
    for (let filter = 0; filter < 5; filter++) {
      let score = 0
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= 4 ? line[i - 4]! : 0
        const up = above[i]!
        const upperLeft = i >= 4 ? above[i - 4]! : 0
        const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upperLeft)
        const value = (line[i]! - predictor) & 0xff
        candidate[i] = value
        score += value < 128 ? value : 256 - value
      }
      if (score < bestScore) {
        bestScore = score
        bestFilter = filter
        best.set(candidate)
      }
    }
    const at = y * (rowBytes + 1)
    filtered[at] = bestFilter
    filtered.set(best, at + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(filtered, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ])
}
