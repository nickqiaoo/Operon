import { createCSSVariablesTheme, registerCustomTheme } from '@pierre/diffs'

const themeName = 'operon-code'

// Tokens keep CSS variable references, so changing a UI preset recolors already
// highlighted files without re-tokenizing them (including worker-rendered diffs).
registerCustomTheme(themeName, async () => {
  const theme = createCSSVariablesTheme({
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
    },
  })
  theme.tokenColors?.push(
    { scope: 'constant.numeric', settings: { foreground: 'var(--code-syntax-number)' } },
    { scope: ['entity.name.type', 'support.type'], settings: { foreground: 'var(--code-syntax-type)' } },
    { scope: 'variable', settings: { foreground: 'var(--code-syntax-variable)' } },
    { scope: 'keyword.operator', settings: { foreground: 'var(--code-syntax-operator)' } },
    { scope: 'invalid', settings: { foreground: 'var(--code-syntax-invalid)' } },
  )
  return theme
})

// Keep both slots so Pierre honors themeType instead of forcing the registered
// theme's base mode. CSS variables supply the active preset's colors in either.
export const PIERRE_THEME = { light: themeName, dark: themeName }
