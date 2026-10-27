import { proxy, useSnapshot } from "valtio"

// WHICH HOME THE OPERATOR KEEPS — the project grid at `/`, or the Console at `/console`.
//
// Both are "home": the switcher at the top of each flips between them, the choice is remembered in this
// browser, and a bare `/` forwards to the Console while that is the one kept (routes.tsx GridRoute). The
// page records the choice on ARRIVAL: `/console` records the Console, and the grid records Projects when
// it is reached through PROJECTS_HREF, the address that says it was chosen.
//
// THE HOUSE IS NOT A WAY TO THE KEPT HOME. The rail's house and the status row's house always go to the
// grid, through PROJECTS_HREF (maintainer 2026-10-27: "Clicking the home button … should always bring
// you to the root / not /console"). They followed the kept home until then, so with the Console kept the
// house sent the operator to the page they were already on, or back to it from a project.
//
// This is where home IS, not which home is ON SCREEN. The switcher's highlighted tab reads the page's
// path: read from here, it followed the storage event below, so choosing Projects in another tab lit
// "Projects" over a Console this tab was still showing.

export type HomeView = "projects" | "console"

const CHOSEN_PARAM = "home"

/**
 * The grid, as an address that says the operator chose it: `/?home=projects`. The switcher's Projects
 * tab and both houses link here rather than to `/`, which forwards to the Console while that is the kept
 * home, so a link opened in a new tab (or followed from a copied link) would have landed back on the
 * Console. The grid records the choice and strips the marker (routes.tsx GridPage).
 */
export const PROJECTS_HREF = `/?${CHOSEN_PARAM}=projects`

/** Did this arrival at the grid come through PROJECTS_HREF? */
export function choseProjects(search: string): boolean {
  return new URLSearchParams(search).get(CHOSEN_PARAM) === "projects"
}

/** `search` with the PROJECTS_HREF marker taken out, ready for the address bar. */
export function withoutProjectsChoice(search: string): string {
  const params = new URLSearchParams(search)
  params.delete(CHOSEN_PARAM)
  const rest = params.toString()
  return rest ? `?${rest}` : ""
}

/**
 * How far down the window the home switcher reaches (components/HomeSwitcher.tsx): its 14px inset, its
 * 36px pill, and 12px of air below. The switcher FLOATS — nothing is drawn behind it, and the page
 * scrolls under it — so this is not a band but a clearance. It sits at the top of the Console's sidebar,
 * which opens under it (CONSOLE_TOP_PX); in the narrow layout, where the cards are stacked under the
 * sidebar and pass under the pill, their headers stick this far down instead (App.tsx).
 */
export const HOME_SWITCHER_CLEARANCE_PX = 62

/**
 * Where the Console's content starts: 8px under the switcher's clearance. The sidebar's status row and
 * the first card both open on this line, and a card the sidebar scrolls to lands on it too, so a landed
 * card sits exactly where the top card sits at rest.
 */
export const CONSOLE_TOP_PX = HOME_SWITCHER_CLEARANCE_PX + 8

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
  // Another tab chose: follow it, so a bare `/` opened here goes where the operator last went anywhere.
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

export function useHomeView(): HomeView {
  return useSnapshot(home).view
}
