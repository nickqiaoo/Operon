import type { ITheme } from "@xterm/xterm"

export type TerminalThemeMode = "light" | "dark"

export interface TerminalTheme {
  id: string
  name: string
  mode: TerminalThemeMode
  /** Swatch colors for the Settings picker: background + a few ANSI hues. */
  preview: { bg: string; dots: readonly string[] }
  /** Full xterm palette. */
  palette: ITheme
}

/** ANSI 0–15 in canonical order. */
type Ansi16 = readonly [
  string, string, string, string, string, string, string, string,
  string, string, string, string, string, string, string, string,
]

function theme(
  id: string,
  name: string,
  mode: TerminalThemeMode,
  bg: string,
  fg: string,
  cursor: string,
  selection: string,
  ansi: Ansi16,
): TerminalTheme {
  const [
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow,
    brightBlue, brightMagenta, brightCyan, brightWhite,
  ] = ansi
  return {
    id,
    name,
    mode,
    preview: { bg, dots: [red, green, yellow, blue, magenta] },
    palette: {
      background: bg,
      foreground: fg,
      cursor,
      cursorAccent: bg,
      selectionBackground: selection,
      black, red, green, yellow, blue, magenta, cyan, white,
      brightBlack, brightRed, brightGreen, brightYellow,
      brightBlue, brightMagenta, brightCyan, brightWhite,
    },
  }
}

// ── House themes — meant to disappear into the app surface rather than sit on
//    it as a separate panel, so their background is overridden at runtime with
//    the live `--color-background` token (see TerminalInstance.buildTheme); the
//    hexes below are the default-theme values, used as a fallback. The rest of
//    the palette harmonizes with the brand colors (purple #6358DC/#8B7DF0,
//    green #3DB87A/#4FCC8E, warm #E5845C/#F09570). These are the defaults. ──

const OPERON_DARK = theme(
  "operon-dark", "Operon Dark", "dark",
  "#0b0b0d", "#e4e4e7", "#e4e4e7", "rgba(212,212,216,0.16)",
  [
    "#3f3f46", "#f0717a", "#4FCC8E", "#e6b673",
    "#7aa2f7", "#9D92F5", "#5fd0c4", "#d4d4d8",
    "#52525b", "#ff8b94", "#6fe0a8", "#f2cd8a",
    "#9cc0ff", "#b3a9ff", "#79e3da", "#fafafa",
  ],
)

const OPERON_LIGHT = theme(
  "operon-light", "Operon Light", "light",
  "#f7f8fb", "#1a1b23", "#1a1b23", "rgba(99,88,220,0.12)",
  [
    "#1a1b23", "#d23f4d", "#2f9e63", "#b07d2b",
    "#3a6fd8", "#6358DC", "#1f8f9e", "#dcdce3",
    "#6b7085", "#e0515f", "#3DB87A", "#c9962f",
    "#5a82e0", "#7B72E4", "#229db0", "#ffffff",
  ],
)

// ── Classic terminal themes ──

const GHOSTTY = theme(
  "ghostty", "Ghostty (Tomorrow Night)", "dark",
  "#282c34", "#ffffff", "#ffffff", "rgba(255,255,255,0.18)",
  [
    "#1d1f21", "#cc6666", "#b5bd68", "#f0c674",
    "#81a2be", "#b294bb", "#8abeb7", "#c5c8c6",
    "#666666", "#d54e53", "#b9ca4a", "#e7c547",
    "#7aa6da", "#c397d8", "#70c0b1", "#eaeaea",
  ],
)

const DRACULA = theme(
  "dracula", "Dracula", "dark",
  "#282a36", "#f8f8f2", "#f8f8f2", "#44475a",
  [
    "#21222c", "#ff5555", "#50fa7b", "#f1fa8c",
    "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
    "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5",
    "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
  ],
)

const TOKYO_NIGHT = theme(
  "tokyo-night", "Tokyo Night", "dark",
  "#1a1b26", "#c0caf5", "#c0caf5", "#283457",
  [
    "#15161e", "#f7768e", "#9ece6a", "#e0af68",
    "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
    "#414868", "#f7768e", "#9ece6a", "#e0af68",
    "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
  ],
)

const CATPPUCCIN_MOCHA = theme(
  "catppuccin-mocha", "Catppuccin Mocha", "dark",
  "#1e1e2e", "#cdd6f4", "#f5e0dc", "#585b70",
  [
    "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af",
    "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
    "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af",
    "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
  ],
)

const NORD = theme(
  "nord", "Nord", "dark",
  "#2e3440", "#d8dee9", "#d8dee9", "#434c5e",
  [
    "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b",
    "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
    "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b",
    "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4",
  ],
)

const GRUVBOX_DARK = theme(
  "gruvbox-dark", "Gruvbox Dark", "dark",
  "#282828", "#ebdbb2", "#ebdbb2", "#504945",
  [
    "#282828", "#cc241d", "#98971a", "#d79921",
    "#458588", "#b16286", "#689d6a", "#a89984",
    "#928374", "#fb4934", "#b8bb26", "#fabd2f",
    "#83a598", "#d3869b", "#8ec07c", "#ebdbb2",
  ],
)

const SOLARIZED_DARK = theme(
  "solarized-dark", "Solarized Dark", "dark",
  "#002b36", "#839496", "#93a1a1", "#073642",
  [
    "#073642", "#dc322f", "#859900", "#b58900",
    "#268bd2", "#d33682", "#2aa198", "#eee8d5",
    "#002b36", "#cb4b16", "#586e75", "#657b83",
    "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
  ],
)

const GITHUB_LIGHT = theme(
  "github-light", "GitHub Light", "light",
  "#ffffff", "#24292e", "#24292e", "#c8e1ff",
  [
    "#24292e", "#d73a49", "#28a745", "#dbab09",
    "#0366d6", "#5a32a3", "#0598bc", "#6a737d",
    "#959da5", "#cb2431", "#22863a", "#b08800",
    "#005cc5", "#5a32a3", "#3192aa", "#d1d5da",
  ],
)

const SOLARIZED_LIGHT = theme(
  "solarized-light", "Solarized Light", "light",
  "#fdf6e3", "#657b83", "#586e75", "#eee8d5",
  [
    "#073642", "#dc322f", "#859900", "#b58900",
    "#268bd2", "#d33682", "#2aa198", "#eee8d5",
    "#002b36", "#cb4b16", "#586e75", "#657b83",
    "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
  ],
)

const CATPPUCCIN_LATTE = theme(
  "catppuccin-latte", "Catppuccin Latte", "light",
  "#eff1f5", "#4c4f69", "#dc8a78", "#ccced9",
  [
    "#5c5f77", "#d20f39", "#40a02b", "#df8e1d",
    "#1e66f5", "#ea76cb", "#179299", "#acb0be",
    "#6c6f85", "#d20f39", "#40a02b", "#df8e1d",
    "#1e66f5", "#ea76cb", "#179299", "#bcc0cc",
  ],
)

const ALL: readonly TerminalTheme[] = [
  OPERON_DARK, GHOSTTY, DRACULA, TOKYO_NIGHT, CATPPUCCIN_MOCHA,
  NORD, GRUVBOX_DARK, SOLARIZED_DARK,
  OPERON_LIGHT, GITHUB_LIGHT, SOLARIZED_LIGHT, CATPPUCCIN_LATTE,
]

export const TERMINAL_THEMES: Record<string, TerminalTheme> = Object.fromEntries(
  ALL.map((t) => [t.id, t]),
)

export const darkTerminalThemes = ALL.filter((t) => t.mode === "dark")
export const lightTerminalThemes = ALL.filter((t) => t.mode === "light")

export const DEFAULT_DARK_TERMINAL_THEME = "operon-dark"
export const DEFAULT_LIGHT_TERMINAL_THEME = "operon-light"

export function getTerminalTheme(id: string): TerminalTheme {
  return (
    TERMINAL_THEMES[id] ??
    TERMINAL_THEMES[DEFAULT_DARK_TERMINAL_THEME] ??
    OPERON_DARK
  )
}
