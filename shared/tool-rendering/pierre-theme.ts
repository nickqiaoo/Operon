import { createCSSVariablesTheme, registerCustomTheme, type DiffsTheme } from '@pierre/diffs'

const themeName = 'operon-code'

// The theme keeps CSS variable references so changing a preset recolors code
// without re-tokenizing it.
const palette = {
  name: themeName,
  variablePrefix: '--operon-code-',
  fontStyle: false,
  variableDefaults: {
    background: 'var(--code-bg)',
    foreground: 'var(--code-fg)',
    'token-keyword': 'var(--code-syntax-keyword)',
    'token-string': 'var(--code-syntax-string)',
    'token-string-expression': 'var(--code-syntax-string)',
    'token-comment': 'var(--code-syntax-comment)',
    'token-constant': 'var(--code-syntax-constant)',
    'token-parameter': 'var(--code-syntax-variable)',
    'token-function': 'var(--code-syntax-function)',
    'token-punctuation': 'var(--code-syntax-operator)',
    'token-link': 'var(--code-syntax-meta)',
    'token-inserted': 'var(--code-diff-added)',
    'token-deleted': 'var(--code-diff-removed)',
    'token-changed': 'var(--code-diff-meta)',
    'token-number': 'var(--code-syntax-number)',
    'token-type': 'var(--code-syntax-type)',
    'token-operator': 'var(--code-syntax-operator)',
  },
}

const theme = createCSSVariablesTheme(palette)
export const PIERRE_HIGHLIGHTS_THEME: DiffsTheme['zed'] = theme.zed
if (PIERRE_HIGHLIGHTS_THEME?.style.syntax) {
  Object.assign(PIERRE_HIGHLIGHTS_THEME.style.syntax, {
    number: 'token-number',
    type: 'token-type',
    operator: 'token-operator',
  })
}
registerCustomTheme(themeName, async () => theme, 'diffs')

// Keep both slots so Pierre honors themeType instead of forcing the registered
// theme's base mode. CSS variables supply the active preset's colors in either.
export const PIERRE_THEME = { light: themeName, dark: themeName }
// Highlighting always runs on Pierre's WASM `highlights` engine; every supported runtime has WASM.
export const PIERRE_HIGHLIGHTER = 'highlights' as const
