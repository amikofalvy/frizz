export interface GithubLabelColors {
  foreground: string
  background: string
  border: string
}

const HEX = /^(?:#)?([0-9a-f]{6})$/i

function externalHue(color: string): string | undefined {
  const match = HEX.exec(color.trim())
  return match ? `#${match[1].toLowerCase()}` : undefined
}

// A label hue is external data, so it never becomes a Frizz foreground directly. The document's
// semantic foreground keeps the text readable in either palette while a measured portion of the
// supplied hue remains in the ink, tint, and border. CSS owns the palette inputs, so these computed
// expressions update on a live theme switch without a React subscription.
export function githubLabelColors(color: string): GithubLabelColors {
  const hue = externalHue(color)
  if (!hue) {
    return {
      foreground: "var(--color-muted)",
      background: "color-mix(in srgb, var(--color-muted) 10%, var(--color-panel))",
      border: "color-mix(in srgb, var(--color-muted) 30%, var(--color-border))",
    }
  }
  return {
    foreground: `color-mix(in srgb, var(--color-fg) 76%, ${hue})`,
    background: `color-mix(in srgb, ${hue} 12%, var(--color-panel))`,
    border: `color-mix(in srgb, ${hue} 36%, var(--color-border))`,
  }
}
