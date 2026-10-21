import { useSyncExternalStore } from "react"

// The screen's device pixels per CSS pixel, live: it changes when a window moves to another display
// and when the page is zoomed, and a `resolution` media query is the only thing that says so.

function subscribe(onChange: () => void): () => void {
  let query: MediaQueryList | undefined
  const changed = () => {
    listen()
    onChange()
  }
  // A query matches ONE ratio, so it fires once on leaving it; each change re-arms it at the new one.
  const listen = () => {
    query?.removeEventListener("change", changed)
    query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    query.addEventListener("change", changed)
  }
  listen()
  return () => query?.removeEventListener("change", changed)
}

export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribe, () => window.devicePixelRatio || 1, () => 1)
}
