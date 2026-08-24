import type { Page } from '@playwright/test'
import { expect } from './fixtures'
import { waitForStreamIdle, waitForAssistantMessage, setFakeScript } from './ci-fixtures'

/**
 * Providers to run shared tests against (used by the legacy `dev` project that
 * connects to a running Electron app). The `ci` project drives everything via
 * the fake runtime instead — see ./ci-fixtures.ts.
 */
export const PROVIDERS = [
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
] as const

export type Provider = (typeof PROVIDERS)[number]

const INPUT_PLACEHOLDER = 'Ask anything, @ to mention files, / to use commands...'

// ---------------------------------------------------------------------------
// Legacy single-function helpers (used by dev project specs).
// ---------------------------------------------------------------------------

/** Click "New chat" and select a provider via the picker dialog. */
export async function newChat(page: Page, provider: Provider) {
  await page.getByRole('button', { name: 'New chat' }).click()
  await page.getByText(provider.label).click()
}

/** Fill the chat input and submit. */
export async function sendMessage(page: Page, message: string) {
  const input = page.getByPlaceholder(INPUT_PLACEHOLDER)
  await input.fill(message)
  await page.getByRole('button', { name: 'Submit' }).click()
}

/** Wait for at least one assistant response to appear. */
export async function waitForResponse(page: Page, timeout = 30_000) {
  await expect(page.locator('[data-testid="message-assistant"]').first()).toBeVisible({ timeout })
}

/** Open Settings panel via top-level button. */
export async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click()
}

/** Go back from Settings to main app. */
export async function closeSettings(page: Page) {
  await page.getByRole('button', { name: 'Back to app' }).click()
}

/** Get the chat input locator. */
export function chatInput(page: Page) {
  return page.getByPlaceholder(INPUT_PLACEHOLDER)
}

/**
 * Auto-approve permission dialogs in the background.
 * Returns an AbortController — call `.abort()` to stop the loop.
 */
export function autoApprove(page: Page, intervalMs = 1000): AbortController {
  const ac = new AbortController()
  const btn = page
    .locator('[data-testid="confirmation"]')
    .getByRole('button', { name: /^Allow$/i })
    .first()

  const timer = setInterval(async () => {
    try {
      if ((await btn.count()) > 0) {
        await btn.click()
      }
    } catch {
      // element gone or page navigated — ignore
    }
  }, intervalMs)

  ac.signal.addEventListener('abort', () => clearInterval(timer))

  return ac
}

// ---------------------------------------------------------------------------
// Namespaced helpers used by ci specs. Prefer these in new tests — they assume
// the fake runtime + ci-fixtures setup and key off data-testid selectors.
// ---------------------------------------------------------------------------

export const chat = {
  /**
   * Open a fresh chat tab using the fake provider. Optionally switches the
   * active fake script first so the response matches the test expectation.
   */
  async openNewChat(page: Page, scriptName?: string): Promise<void> {
    if (scriptName) await setFakeScript(scriptName)
    await page.getByTestId('new-tab-button').click()
    // "New Chat" is a submenu trigger; hover to reveal the provider options.
    await page.getByTestId('new-chat-menuitem').hover()
    await page.getByTestId('provider-option-fake').click()
  },

  /**
   * Type a message into the chat input and submit. Uses the legacy placeholder
   * locator since `chat-input` testid is shared by many components.
   */
  async sendMessage(page: Page, text: string): Promise<void> {
    const input = page.getByPlaceholder(INPUT_PLACEHOLDER)
    await input.fill(text)
    await page.getByRole('button', { name: 'Submit' }).click()
  },

  /** Wait for the active stream to idle (the standard "message complete" gate). */
  async waitForIdle(page: Page, timeout = 15_000): Promise<void> {
    await waitForStreamIdle(page, timeout)
  },

  /** Wait for an assistant message to appear (typically before waitForIdle). */
  async waitForAssistant(page: Page, timeout = 15_000): Promise<void> {
    await waitForAssistantMessage(page, timeout)
  },

  /** Assert that a message of the given role contains text matching `matcher`. */
  async expectMessage(
    page: Page,
    role: 'user' | 'assistant',
    matcher: string | RegExp,
  ): Promise<void> {
    const msg = page.locator(`[data-testid="message-${role}"]`).first()
    await expect(msg).toBeVisible()
    await expect(msg).toContainText(matcher)
  },

  /** Click the stop/abort button while streaming. */
  async stopStream(page: Page): Promise<void> {
    const stopBtn = page.getByTestId('chat-stop')
    if ((await stopBtn.count()) > 0) {
      await stopBtn.first().click()
      return
    }
    // Fallback: ai-elements PromptInputSubmit toggles to a stop button when streaming.
    await page.getByRole('button', { name: /stop/i }).first().click()
  },
}

export const settings = {
  /** Open the settings panel. */
  async open(page: Page): Promise<void> {
    await page.getByTestId('settings-button').click()
    await expect(page.getByTestId('settings-dialog')).toBeVisible()
  },

  /** Click a settings tab by name. */
  async openTab(page: Page, tabName: string): Promise<void> {
    const tab = page.getByTestId(`settings-tab-${tabName}`)
    if ((await tab.count()) > 0) {
      await tab.first().click()
      return
    }
    // Fallback to text-based selection until all tabs have testids.
    await page.getByRole('tab', { name: new RegExp(tabName, 'i') }).first().click()
  },

  /** Close the settings panel. */
  async close(page: Page): Promise<void> {
    const back = page.getByTestId('settings-back-button')
    if ((await back.count()) > 0) {
      await back.first().click()
      return
    }
    await page.getByRole('button', { name: 'Back to app' }).first().click()
  },
}

export const tabs = {
  /** Switch to the tab at index `i` (0-based). */
  async switchTo(page: Page, index: number): Promise<void> {
    const tab = page.getByTestId(`tab-${index}`)
    await tab.first().click()
  },

  /** Close the tab at index `i`. The close button is hover-only, so we hover the tab first. */
  async close(page: Page, index: number): Promise<void> {
    await page.getByTestId(`tab-${index}`).first().hover()
    await page.getByTestId(`tab-close-${index}`).first().click({ force: true })
  },

  /** Snapshot of all open tabs from the probe. */
  async list(page: Page) {
    return page.evaluate(() => window.__operon?.tabs() ?? [])
  },
}
