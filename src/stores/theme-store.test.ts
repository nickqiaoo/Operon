// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ui-themes', () => ({
  getThemeById: () => undefined,
  applyUIThemeColors: vi.fn(),
  clearUIThemeColors: vi.fn(),
}))

const { applyTheme } = await import('./theme-store')

let systemDark = false
const setThemeSource = vi.fn(async () => {})

beforeEach(() => {
  systemDark = false
  setThemeSource.mockClear()
  Object.assign(window, {
    matchMedia: (query: string) => ({ matches: query.includes('dark') && systemDark, addEventListener() {}, removeEventListener() {} }),
    electronAPI: { setThemeSource },
  })
})
afterEach(() => {
  Reflect.deleteProperty(window, 'electronAPI')
})

describe('applyTheme', () => {
  it("draws the browser's own controls in the app's mode, not the OS's", () => {
    applyTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')

    systemDark = true
    applyTheme('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('follows the OS for System', () => {
    systemDark = true
    applyTheme('system')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })

  it('hands the choice itself to Electron, so System stays live there', () => {
    applyTheme('dark')
    applyTheme('system')
    expect(setThemeSource.mock.calls).toEqual([['dark'], ['system']])
  })

  it('does nothing extra outside the desktop app', () => {
    Reflect.deleteProperty(window, 'electronAPI')
    expect(() => applyTheme('dark')).not.toThrow()
  })
})
