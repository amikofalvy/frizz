import { useSyncExternalStore } from "react"

// WHERE A NEW THREAD STARTED ON THE CONSOLE RUNS. The Console names no project of its own, so every
// surface there that starts a thread — the sidebar's prompt box, ⌘K's "New thread" dialog, the phone's
// new-thread page — is pointed at one by the project chip (components/ConsoleProjectChip.tsx). They
// share ONE choice: a project picked in the dialog is the one the sidebar's box shows after it closes,
// and the choice outlives the page in localStorage. A remembered project that is no longer open falls
// back to the first open one in the rail's order.

const PICK_KEY = "frizz:console-dispatch-project"

function read(): string | null {
  try {
    return localStorage.getItem(PICK_KEY)
  } catch {
    return null
  }
}

let picked: string | null | undefined
const listeners = new Set<() => void>()

function current(): string | null {
  // Read lazily, so importing this module touches no storage (unit tests have none).
  if (picked === undefined) picked = read()
  return picked
}

/** Point every Console new-thread surface at `slug`, and remember it. */
export function pickConsoleDispatchProject(slug: string): void {
  picked = slug
  try {
    localStorage.setItem(PICK_KEY, slug)
  } catch {
    // Not remembered, but it holds for this page.
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The remembered choice, which may name a project that is no longer open — see `consoleDispatchProject`. */
export function useConsoleDispatchPick(): string | null {
  return useSyncExternalStore(subscribe, current, current)
}

/** The project a new thread goes to: the remembered one while it is still open, else the first. */
export function consoleDispatchProject<P extends { slug: string }>(projects: readonly P[], pick: string | null): P | undefined {
  return projects.find((project) => project.slug === pick) ?? projects[0]
}
