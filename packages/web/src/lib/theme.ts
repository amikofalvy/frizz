export type ThemePreference = "system" | "light" | "dark"
export type ResolvedTheme = "light" | "dark"

export interface ThemeSnapshot {
  preference: ThemePreference
  resolved: ResolvedTheme
}

export const THEME_STORAGE_KEY = "frizz-theme"

const DARK_CANVAS = "#0d0e10"
const LIGHT_CANVAS = "#f6f8fa"
const listeners = new Set<() => void>()
let snapshot: ThemeSnapshot = { preference: "system", resolved: "light" }
let initialized = false
let media: MediaQueryList | undefined

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system"
}

export function resolveTheme(preference: ThemePreference, dark = systemPrefersDark()): ResolvedTheme {
  return preference === "system" ? (dark ? "dark" : "light") : preference
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches
}

function storedPreference(): ThemePreference {
  try {
    return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return "system"
  }
}

function apply(next: ThemeSnapshot) {
  const root = document.documentElement
  root.dataset.theme = next.resolved
  root.style.colorScheme = next.resolved
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next.resolved === "dark" ? DARK_CANVAS : LIGHT_CANVAS)
}

function publish(preference: ThemePreference) {
  const next = { preference, resolved: resolveTheme(preference) }
  const changed = next.preference !== snapshot.preference || next.resolved !== snapshot.resolved
  snapshot = next
  apply(next)
  if (changed) for (const listener of listeners) listener()
}

export function getThemeSnapshot(): ThemeSnapshot {
  return snapshot
}

export function setThemePreference(preference: ThemePreference) {
  publish(parseThemePreference(preference))
  try {
    localStorage.setItem(THEME_STORAGE_KEY, snapshot.preference)
  } catch {
    // A private or quota-limited browser still retains the selected theme for this document.
  }
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function initTheme() {
  if (initialized || typeof window === "undefined") return
  initialized = true
  publish(storedPreference())
  media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : undefined
  const mediaChange = () => snapshot.preference === "system" && publish("system")
  media?.addEventListener("change", mediaChange)
  const storageChange = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) publish(storedPreference())
  }
  window.addEventListener("storage", storageChange)
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      media?.removeEventListener("change", mediaChange)
      window.removeEventListener("storage", storageChange)
      initialized = false
      media = undefined
    })
  }
}
