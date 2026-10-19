import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import type { ComponentProps, ReactNode } from "react"
import { OPAQUE_PORTAL_SURFACE_CLASS } from "../../lib/overlaySurface.ts"

// Thin styled wrappers over Radix DropdownMenu so call sites read declaratively. The popover
// matches the Select: elevated bg, soft shadow, padded rounded items. These are anchored popovers,
// not modal dialogs: keep the surrounding app visible to assistive technology and pointer-capable
// while the menu is open. Radix defaults DropdownMenu to modal, which otherwise aria-hides #root and
// disables body pointer events even though no visual overlay is rendered.
export function Menu({ modal = false, ...props }: ComponentProps<typeof RadixMenu.Root>) {
  return <RadixMenu.Root modal={modal} {...props} />
}
export const MenuTrigger = RadixMenu.Trigger

export function MenuContent({
  children,
  align = "end",
  sideOffset = 6,
}: {
  children: ReactNode
  align?: "start" | "center" | "end"
  sideOffset?: number
}) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        align={align}
        sideOffset={sideOffset}
        className={`${OPAQUE_PORTAL_SURFACE_CLASS} min-w-[184px] overflow-hidden rounded-lg p-1`}
      >
        {children}
      </RadixMenu.Content>
    </RadixMenu.Portal>
  )
}

export function MenuItem({
  children,
  onSelect,
  icon,
  danger,
  disabled,
  title,
}: {
  children: ReactNode
  onSelect: () => void
  icon?: ReactNode
  danger?: boolean
  /** Greyed out, skipped by the keyboard, and inert to a click — Radix's own disabled item. */
  disabled?: boolean
  /** The native tooltip: why a disabled row is disabled. */
  title?: string
}) {
  return (
    <RadixMenu.Item
      onSelect={onSelect}
      disabled={disabled}
      title={title}
      className={`flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] outline-none transition-colors data-[highlighted]:bg-panel-2 data-[disabled]:cursor-default data-[disabled]:opacity-45 ${
        danger
          ? "text-danger data-[highlighted]:text-danger-soft"
          : "text-muted data-[highlighted]:text-fg"
      }`}
    >
      {icon && <span className="flex w-3.5 shrink-0 items-center justify-center">{icon}</span>}
      {children}
    </RadixMenu.Item>
  )
}

export function MenuSeparator() {
  return <RadixMenu.Separator className="my-1 h-px bg-border" />
}
