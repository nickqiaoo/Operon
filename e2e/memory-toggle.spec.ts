import { test, expect } from './fixtures'
import { closeSettings, newChat, openSettings, sendMessage, waitForResponse } from './helpers'

/**
 * Test: Memory toggle controls whether the Memory tool is available in chat.
 *
 * 1. Enable Memory in Settings → new chat should invoke Memory tool
 * 2. Disable Memory in Settings → new chat should NOT invoke Memory tool
 */
test.describe('Memory toggle', () => {
  const MEMORY_PROMPT = 'remember that my favorite color is blue'

  async function setMemoryToggle(page: import('@playwright/test').Page, enabled: boolean) {
    const backToApp = page.getByRole('button', { name: 'Back to app' })
    if (!(await backToApp.isVisible().catch(() => false))) {
      await openSettings(page)
    }

    await page.getByRole('button', { name: 'Memory' }).click()

    const toggle = page.getByRole('switch', { name: 'Enable Memory Embedding' })
    await expect(toggle).toBeVisible()

    const isCurrentlyEnabled = (await toggle.getAttribute('aria-checked')) === 'true'

    if (isCurrentlyEnabled !== enabled) {
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-checked', enabled ? 'true' : 'false')
    }

    await closeSettings(page)
    await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible()
  }

  test('Memory tool is invoked when Memory is enabled', async ({ appPage: page }) => {
    await setMemoryToggle(page, true)

    await newChat(page, { id: 'gemini', label: 'Gemini CLI' })
    await sendMessage(page, MEMORY_PROMPT)
    await waitForResponse(page)

    // Tool invocation card should contain a tool with "memory" in its name
    await expect(
      page.locator('[data-testid="tool-invocation"] [data-testid="tool-name"]').filter({ hasText: /memory/i }).first()
    ).toBeVisible({ timeout: 10_000 })
  })

  test('Memory tool is NOT invoked when Memory is disabled', async ({ appPage: page }) => {
    await setMemoryToggle(page, false)

    await newChat(page, { id: 'gemini', label: 'Gemini CLI' })
    await sendMessage(page, MEMORY_PROMPT)
    await waitForResponse(page)

    // Give extra time for the full response to complete
    await page.waitForTimeout(5_000)
    await expect(
      page.locator('[data-testid="tool-invocation"] [data-testid="tool-name"]').filter({ hasText: /memory/i })
    ).toHaveCount(0)
  })
})
