import { test as base, type Page, chromium } from '@playwright/test'

const CDP_PORT = process.env.CDP_PORT || '9223'

/**
 * Custom fixture that connects to the running Electron app via CDP WebSocket.
 *
 * Usage:
 *   1. Start the app in dev mode: pnpm dev
 *   2. Run tests: pnpm test:e2e
 */
export const test = base.extend<{ appPage: Page }>({
  appPage: async ({}, use) => {
    // Fetch the WebSocket debugger URL from CDP endpoint
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
    if (!res.ok) {
      throw new Error(
        `Cannot connect to CDP on port ${CDP_PORT}. Is the app running in dev mode?`
      )
    }
    const { webSocketDebuggerUrl } = await res.json()

    const browser = await chromium.connectOverCDP(webSocketDebuggerUrl)
    const context = browser.contexts()[0]

    if (!context) {
      throw new Error('No browser context found. Is the Electron window open?')
    }

    // Find the app page by URL (avoid picking DevTools or other pages)
    const pages = context.pages()
    const page = pages.find((p) => p.url().includes('localhost')) ?? pages[0]

    if (!page) {
      throw new Error('No page found in the Electron window.')
    }

    await use(page)

    // Don't close the browser - it's the user's running Electron app
  },
})

export { expect } from '@playwright/test'
