import { createRoot } from "react-dom/client"
import type { ReactNode } from "react"
import { Command } from "cmdk"
import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import { LinkedHtml } from "./components/LinkedHtml.tsx"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./components/ui/Menu.tsx"
import { useMarkdownHtml } from "./lib/useMarkdown.ts"
import "./styles.css"

// THE POINTER RULE, against real controls (styles.css § "THE POINTER IS FOR WHATEVER A CLICK ACTS ON";
// lib/pointerCursor.e2e.test.ts reads it). Every element carrying `data-expect` must show that cursor
// under the pointer: the clickable ones a hand, the disabled ones the arrow (or the cursor their own
// utility asks for). The cases are the shapes the 2026-10-20 audit found: a Radix menu row that opted out
// with `cursor-default` (the project rail's, the project picker's and the Console chip's menus), a
// control disabled with `aria-disabled` that the rule pointed a hand at anyway, and a bare checkbox.

function Case({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section data-case={name} className="flex flex-wrap items-center gap-3 border-b border-border py-3">
      <h2 className="w-40 shrink-0 text-[11px] uppercase tracking-wide text-muted">{name}</h2>
      {children}
    </section>
  )
}

function Disclosure() {
  const html = useMarkdownHtml("<details>\n<summary>Full test output</summary>\n\nThe body.\n\n</details>")
  return <LinkedHtml className="md-body" html={html} />
}

function Fixture() {
  return (
    <div className="min-h-screen bg-bg p-6 text-[13px] text-fg">
      <Case name="native">
        <button type="button" data-expect="pointer" className="rounded border border-border px-2 py-1">Button</button>
        <button type="button" disabled data-expect="default" className="rounded border border-border px-2 py-1">Disabled</button>
        <button type="button" aria-disabled="true" data-expect="not-allowed" className="cursor-not-allowed rounded border border-border px-2 py-1">aria-disabled, not-allowed</button>
        <button type="button" aria-disabled="true" data-expect="default" className="cursor-default rounded border border-border px-2 py-1">aria-disabled, default</button>
        <a href="#x" data-expect="pointer">Link</a>
        <select data-expect="pointer" defaultValue="a"><option value="a">Select</option></select>
        <select disabled data-expect="default" defaultValue="a"><option value="a">Disabled select</option></select>
      </Case>
      <Case name="inputs">
        <input type="checkbox" aria-label="Bare checkbox" data-expect="pointer" />
        <input type="checkbox" aria-label="Disabled checkbox" disabled data-expect="default" />
        <input type="radio" aria-label="Bare radio" data-expect="pointer" />
        <label data-expect="pointer" className="flex items-center gap-1.5"><input type="checkbox" />Labelled checkbox</label>
      </Case>
      <Case name="roles">
        <div role="tab" tabIndex={0} aria-selected="false" data-expect="pointer" className="px-2 py-1">Tab</div>
        <div role="switch" tabIndex={0} aria-checked="false" data-expect="pointer" className="px-2 py-1">Switch</div>
        <div role="radio" tabIndex={0} aria-checked="false" data-expect="pointer" className="px-2 py-1">Radio</div>
        <div role="checkbox" tabIndex={0} aria-checked="true" aria-disabled="true" data-expect="auto" className="px-2 py-1">Settled checkbox</div>
        <div role="button" tabIndex={0} data-expect="pointer" className="px-2 py-1">Role button</div>
      </Case>
      <Case name="disclosure">
        <div data-expect-within="summary" className="w-80"><Disclosure /></div>
      </Case>
      <Case name="palette">
        <Command label="Palette" className="w-60">
          <Command.List>
            <Command.Item data-expect="pointer" value="first">Palette item</Command.Item>
          </Command.List>
        </Command>
      </Case>
      <Case name="menu">
        <div className="h-40">
          <Menu open>
            <MenuTrigger asChild>
              <button type="button" className="rounded border border-border px-2 py-1">Menu</button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuItem onSelect={() => {}}><span data-expect="pointer">Enabled item</span></MenuItem>
              <MenuItem disabled onSelect={() => {}}><span data-expect="default">Disabled item</span></MenuItem>
              {/* The three project menus' shape before the audit: a bare Radix item carrying its own
                  `cursor-default`. The rule outranks the utility, so it still points. */}
              <RadixMenu.Item className="cursor-default rounded px-2 py-1.5 outline-none data-[highlighted]:bg-panel-2" onSelect={() => {}}>
                <span data-expect="pointer">Opted-out item</span>
              </RadixMenu.Item>
            </MenuContent>
          </Menu>
        </div>
      </Case>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
