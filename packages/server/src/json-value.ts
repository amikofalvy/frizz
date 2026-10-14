// Structural equality and copy for JSON-shaped values: primitives, arrays and plain objects.
//
// Used where a memo must decide "is this freshly derived value the same as the one I handed out" (the
// tailer's telemetry memo, the board's archived-view memo). Two rules matter there and differ from a
// generic deep-equal:
//   * a key whose value is `undefined` equals a missing key — exactly as the value serializes, which is
//     the only form these objects ever leave the server in;
//   * anything that is not an array or a plain object (a Map, a Date, a class instance) is compared by
//     identity and copied by reference. The values these helpers see are built from object literals, so
//     that branch is a safety net, not a code path.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false
    return true
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false
    for (const key in a) if (!jsonEqual(a[key], b[key])) return false
    for (const key in b) if (!(key in a) && b[key] !== undefined) return false
    return true
  }
  // NaN is the one primitive not === itself; JSON writes it as null, so two NaNs are the same value.
  return typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)
}

export function jsonCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(jsonCopy) as T
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key in value) out[key] = jsonCopy(value[key])
    return out as T
  }
  return value
}
