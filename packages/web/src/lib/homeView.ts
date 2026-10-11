import { proxy, useSnapshot } from "valtio"
import { CONSOLE_PATH } from "./base-path.ts"

// WHICH HOME THE OPERATOR KEEPS — the project grid at `/`, or the Console at `/console`.
//
// Both are "home": the switcher at the top of each flips between them, and every way back home (the
// rail's house, the status row's house) goes to whichever was used last. So the choice is remembered in
// this browser, and `/` itself forwards to the Console while that is the one kept (routes.tsx GridRoute).
// The switcher records the choice BEFORE it navigates, which is what lets "Projects" reach the grid at
// all while the remembered home is still the Console.

export type HomeView = "projects" | "console"

/**
 * The height of the home switcher's fixed band (components/HomeSwitcher.tsx): its 14px inset, its 36px
 * pill, and a 12px fade below. Everything on a home page that sticks to the top of the window sticks
 * below it instead — the Console's sidebar, its cards' headers, and a scroll that lands a card.
 */
export const HOME_BAND_PX = 62

/**
 * Where the Console's content starts: 8px under the band. The sidebar's status row and the first card
 * both open on this line, and a card the sidebar scrolls to lands on it too, so a landed card sits
 * exactly where the top card sits at rest.
 */
export const CONSOLE_TOP_PX = HOME_BAND_PX + 8

const KEY = "frizz:home-view"

function read(): HomeView {
  try {
    return localStorage.getItem(KEY) === "console" ? "console" : "projects"
  } catch {
    return "projects"
  }
}

const home = proxy({ view: typeof window === "undefined" ? ("projects" as HomeView) : read() })

// Guarded for the unit tests, which import the store (and so this) under a stubbed `window`.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  // Another tab chose: follow it, so a house clicked here goes where the operator last went anywhere.
  window.addEventListener("storage", (event) => {
    if (event.key === KEY) home.view = read()
  })
}

export function homeView(): HomeView {
  return home.view
}

export function setHomeView(view: HomeView): void {
  if (home.view !== view) home.view = view
  try {
    localStorage.setItem(KEY, view)
  } catch {
    // Storage refused (a private window): the choice holds for this page and is not remembered.
  }
}

/** Where "home" is for the operator right now. */
export function homeHref(view: HomeView = home.view): string {
  return view === "console" ? CONSOLE_PATH : "/"
}

export function useHomeView(): HomeView {
  return useSnapshot(home).view
}
