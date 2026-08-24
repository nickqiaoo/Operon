import { test, expect } from './fixtures'
import { PROVIDERS, newChat, sendMessage, waitForResponse, autoApprove } from './helpers'

for (const provider of PROVIDERS) {
  test.describe(`cdp mcp [${provider.label}]`, () => {
    test('list_pages tool is invoked after sending CDP prompt', async ({ appPage: page }) => {
      await newChat(page, provider)

      const approver = autoApprove(page)

      await sendMessage(page, 'use cdp to inspect the app UI')
      await waitForResponse(page)

      // A tool invocation card should appear containing list_pages
      const toolCard = page.locator('[data-testid="tool-invocation"]').filter({
        has: page.locator('[data-testid="tool-name"]', { hasText: /list_pages/i }),
      })
      await expect(toolCard.first()).toBeVisible({ timeout: 30_000 })

      approver.abort()
    })
  })
}
