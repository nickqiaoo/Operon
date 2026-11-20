/**
 * The Code Font setting offers a short built-in list of common programming
 * fonts, showing only the ones this device can actually draw. Nothing is typed
 * by hand, and the system's whole font list isn't dumped into the picker.
 */

/** `ui-monospace` is how WebKit hands out the system's SF Mono, which it can't reach by name. Chromium doesn't support it. */
export const SYSTEM_MONO = "ui-monospace"

/** Default, and the stack every choice falls back through. */
export const DEFAULT_CODE_FONT = "Monaco"
const FALLBACK_STACK = `Monaco, "SF Mono", ui-monospace, Menlo, monospace`

/** Nerd Fonts patches rename a face (JetBrains Mono → "JetBrainsMono Nerd Font", "JetBrainsMono NF", …). */
function nerdVariants(compact: string): string[] {
  return [`${compact} Nerd Font`, `${compact} Nerd Font Mono`, `${compact} NF`, `${compact} NFM`]
}

/**
 * In display order. Each font lists the family names it may be installed
 * under; the first one that draws is the one stored.
 */
const BUILT_IN_FONTS: ReadonlyArray<{ label: string; families: readonly string[] }> = [
  { label: "Monaco", families: [DEFAULT_CODE_FONT] },
  // By name only where someone installed it; macOS keeps its own copy hidden.
  // `ui-monospace` reaches that copy in WebKit (not Chromium).
  { label: "SF Mono", families: ["SF Mono", SYSTEM_MONO] },
  { label: "Menlo", families: ["Menlo"] },
  { label: "JetBrains Mono", families: ["JetBrains Mono", ...nerdVariants("JetBrainsMono"), ...nerdVariants("JetBrainsMonoNL")] },
  { label: "Fira Code", families: ["Fira Code", ...nerdVariants("FiraCode")] },
  { label: "Cascadia Code", families: ["Cascadia Code", "Cascadia Mono", ...nerdVariants("CaskaydiaCove")] },
  { label: "Source Code Pro", families: ["Source Code Pro", ...nerdVariants("SauceCodePro")] },
  { label: "IBM Plex Mono", families: ["IBM Plex Mono", ...nerdVariants("BlexMono")] },
  { label: "Hack", families: ["Hack", ...nerdVariants("Hack")] },
  { label: "Consolas", families: ["Consolas"] },
]

export interface CodeFontOption {
  /** CSS family name (or `ui-monospace`). */
  family: string
  label: string
}

export function codeFontLabel(family: string): string {
  return BUILT_IN_FONTS.find((font) => font.families.includes(family))?.label ?? family
}

function cssFamily(family: string): string {
  return family === SYSTEM_MONO ? family : `"${family.replace(/["\\]/g, "")}"`
}

/** The font-family stack for a chosen family: it first, then the defaults. */
export function codeFontStack(family: string): string {
  return `${cssFamily(family)}, ${FALLBACK_STACK}`
}

/**
 * Installed and monospace, in one measurement: with a proportional fallback
 * (serif), a missing face draws "iiiii" and "WWWWW" at different widths.
 */
function isAvailable(ctx: CanvasRenderingContext2D, family: string): boolean {
  ctx.font = `32px ${cssFamily(family)}, serif`
  return Math.abs(ctx.measureText("iiiii").width - ctx.measureText("WWWWW").width) < 0.5
}

let detected: CodeFontOption[] | undefined

/** The built-in fonts this device can draw. Synchronous (system fonts need no loading), computed once. */
export function availableCodeFonts(): CodeFontOption[] {
  if (detected) return detected
  const ctx = document.createElement("canvas").getContext("2d")
  detected = []
  if (ctx) {
    for (const font of BUILT_IN_FONTS) {
      const family = font.families.find((name) => isAvailable(ctx, name))
      if (family) detected.push({ family, label: font.label })
    }
  }
  return detected
}
