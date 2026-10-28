import { useSyncExternalStore } from 'react'
import { HTML_RENDER_THEME_TOKENS, type HtmlRenderTheme } from '@shared/html-render'

/**
 * The app's current theme as the variables a visual reply page reads.
 *
 * Read from the computed style instead of a token table, so it is whatever is
 * actually on screen: the default theme from globals.css, or a ported preset
 * that `applyUIThemeColors` wrote inline. Both flip through attributes on
 * <html> (the `dark` class, inline variables), which is what the observer watches.
 */

const MONO_FONT = '"SF Mono", Menlo, Monaco, ui-monospace, monospace'

function readTheme(): HtmlRenderTheme {
  const root = document.documentElement
  const style = getComputedStyle(root)
  const variables: Record<string, string> = {}
  for (const [name, token] of Object.entries(HTML_RENDER_THEME_TOKENS)) {
    const value = style.getPropertyValue(token).trim()
    if (value) variables[name] = value
  }
  // Card radius (rounded-xl): the boxes a page draws are cards in our scale.
  variables['--radius'] = '12px'
  variables['--font-sans'] = getComputedStyle(document.body).fontFamily
  variables['--font-mono'] = MONO_FONT
  return { appearance: root.classList.contains('dark') ? 'dark' : 'light', variables }
}

let current: HtmlRenderTheme | null = null
let currentKey = ''
const listeners = new Set<() => void>()
let observer: MutationObserver | null = null

function refresh() {
  const next = readTheme()
  const key = JSON.stringify(next)
  if (key === currentKey) return
  current = next
  currentKey = key
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!observer) {
    observer = new MutationObserver(refresh)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = null
      // Unwatched, the cache can go stale; the next subscriber reads afresh.
      current = null
      currentKey = ''
    }
  }
}

function getSnapshot(): HtmlRenderTheme {
  if (!current) refresh()
  return current as HtmlRenderTheme
}

export function useHtmlRenderTheme(): HtmlRenderTheme {
  return useSyncExternalStore(subscribe, getSnapshot)
}
