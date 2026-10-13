import { subscribe } from "valtio"
import { prefs } from "./prefs.ts"

// "Wrap code" (Settings, a browser preference in lib/prefs.ts) reaches the page as ONE attribute on
// <html>, which styles.css turns into the `white-space` of every fenced code block and Edit card row.
// An attribute and a stylesheet rule rather than a class per block: fenced code leaves the Markdown
// pipeline as an HTML string that every surface injects (lib/syntaxHighlight.ts), so there is no
// component to hand a preference to, and a flip has to reach the blocks already on the page.
//
// Called before the first render (main.tsx), and prefs seeds synchronously from localStorage, so a
// browser that turned wrapping off never paints wrapped code first. In a transcript that frame is a
// different height, and the scroll position would be restored against it.
export function initCodeWrap(): void {
  const apply = () => {
    document.documentElement.dataset.codeWrap = prefs.wrapCode ? "on" : "off"
  }
  apply()
  subscribe(prefs, apply)
}
