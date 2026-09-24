import qrcode from "qrcode-generator"

/**
 * Render a string as a QR code sized for a terminal.
 *
 * Three decisions worth stating, because each is the difference between "scans instantly" and "does
 * not scan at all":
 *
 * NO GLYPHS WHEN THERE IS ROOM. A terminal paints a cell's BACKGROUND edge to edge; it paints a
 * GLYPH wherever the font put the ink, and a font's block glyphs need not fill the cell. Measured on
 * the maintainer's terminal (2026-09-23, screenshot of a real Tailscale sign-in): every `▀` was one
 * pixel narrower than its 14-pixel cell, so a hairline of the terminal's own background ran down
 * every column boundary through every glyph — while the quiet zone, painted as background alone,
 * was seamless in both directions (values 229–230 across 110 pixels, no dips). The finder patterns
 * came out as combs and the phone would not read them ("the markers are not solid, there are random
 * lines going through it"). So the default rendering draws NOTHING: one module per terminal row, two
 * background-painted spaces per module (cells are about twice as tall as wide, so two make a square),
 * and there is no ink for a font or a minimum-contrast setting to mistreat.
 *
 * HALF BLOCKS WHEN THERE IS NOT. Two columns and one row per module needs `2×size` columns and
 * `size` rows — 90×45 for a five-version code — and a QR the terminal wraps or scrolls is as
 * unscannable as a striped one. Below that, two module ROWS share one cell: a half block in dark ink
 * on a light background, `▀` when the top module is the dark one and `▄` when the bottom is, and a
 * bare background-painted space when both are the same. That still draws glyphs on the mixed cells,
 * so it inherits the font's hairlines there; it is the fallback, not the default.
 *
 * EXPLICIT COLOUR, NOT THE THEME. A QR needs dark modules on a light field. Drawing in the terminal's
 * default colours inverts that on a dark theme, which is most of them, and an inverted QR does not
 * scan on iOS. So every cell sets its own colours. The quiet zone is drawn, not assumed — a QR flush
 * against surrounding text is unreadable even when the code itself is perfect.
 */

const LIGHT_BG = "\x1b[48;5;15m"
const DARK = "\x1b[38;5;0m"
const DARK_BG = "\x1b[48;5;0m"
const RESET = "\x1b[0m"
const UPPER_HALF = "▀"
const LOWER_HALF = "▄"
/** Four modules is the spec's minimum quiet zone; less and the finder patterns stop being findable. */
const QUIET_ZONE = 4
/** Rows the panes print around the code — a heading, the URL, a status line — that must fit too. */
const SURROUNDING_ROWS = 6

export type QrStyle = "blocks" | "half"

export interface QrRenderOptions {
  /** Error correction. "M" tolerates ~15% damage, which covers a slightly out-of-focus phone camera. */
  errorCorrection?: "L" | "M" | "Q" | "H"
  /** Emit plain `#`/space instead of ANSI colour, for tests and non-TTY sinks. */
  plain?: boolean
  /**
   * `blocks` — one module per row, two background-painted columns per module, no glyphs at all.
   * `half` — two module rows per cell via half blocks; half the height, but glyph-dependent.
   * Omitted: `blocks` when `columns`/`rows` have room for it, else `half`.
   */
  style?: QrStyle
  /** The terminal's size, for choosing the style. Defaults to stdout's, or 80×24 without a TTY. */
  columns?: number
  rows?: number
}

/** True when the module at (x, y) is dark; anything outside the code is quiet zone, hence light. */
type ModuleAt = (x: number, y: number) => boolean

function encode(value: string, errorCorrection: "L" | "M" | "Q" | "H"): { size: number; at: ModuleAt } {
  // Type 0 asks the encoder to pick the smallest version that fits.
  const code = qrcode(0, errorCorrection)
  code.addData(value)
  code.make()
  const modules = code.getModuleCount()
  const size = modules + QUIET_ZONE * 2
  return {
    size,
    at: (x, y) => {
      const mx = x - QUIET_ZONE
      const my = y - QUIET_ZONE
      if (mx < 0 || my < 0 || mx >= modules || my >= modules) return false
      return code.isDark(my, mx)
    },
  }
}

/** The style a code of `size` modules gets, given the terminal it is going to. */
export function qrStyleFor(size: number, options: Pick<QrRenderOptions, "style" | "columns" | "rows"> = {}): QrStyle {
  if (options.style) return options.style
  const columns = options.columns ?? process.stdout.columns ?? 80
  const rows = options.rows ?? process.stdout.rows ?? 24
  return columns >= size * 2 && rows >= size + SURROUNDING_ROWS ? "blocks" : "half"
}

/**
 * The code as terminal lines, quiet zone included. Returns lines rather than a blob so a caller can
 * centre it, box it, or repaint a region without re-encoding.
 */
export function renderQrLines(value: string, options: QrRenderOptions = {}): string[] {
  if (!value) throw new Error("renderQr requires a value")
  const { size, at } = encode(value, options.errorCorrection ?? "M")
  const lines: string[] = []
  if (qrStyleFor(size, options) === "blocks") {
    for (let y = 0; y < size; y++) {
      let line = ""
      for (let x = 0; x < size; x++) {
        const dark = at(x, y)
        line += options.plain ? (dark ? "##" : "  ") : `${dark ? DARK_BG : LIGHT_BG}  `
      }
      lines.push(options.plain ? line : `${line}${RESET}`)
    }
    return lines
  }
  // Two module rows per terminal row. An odd final row pairs with quiet zone, which is light anyway.
  for (let y = 0; y < size; y += 2) {
    let line = ""
    for (let x = 0; x < size; x++) {
      const top = at(x, y)
      const bottom = y + 1 < size ? at(x, y + 1) : false
      if (options.plain) {
        line += top && bottom ? "#" : top ? "^" : bottom ? "v" : " "
        continue
      }
      if (top === bottom) line += `${top ? DARK_BG : LIGHT_BG} `
      else line += `${DARK}${LIGHT_BG}${top ? UPPER_HALF : LOWER_HALF}`
    }
    lines.push(options.plain ? line : `${line}${RESET}`)
  }
  return lines
}

/** Convenience for printing straight to a terminal. */
export function renderQr(value: string, options: QrRenderOptions = {}): string {
  return renderQrLines(value, options).join("\n")
}

/** Width in terminal columns, so a caller can centre or box the code without rendering it first. */
export function qrWidth(value: string, errorCorrection: "L" | "M" | "Q" | "H" = "M", options: Pick<QrRenderOptions, "style" | "columns" | "rows"> = {}): number {
  const { size } = encode(value, errorCorrection)
  return qrStyleFor(size, options) === "blocks" ? size * 2 : size
}
