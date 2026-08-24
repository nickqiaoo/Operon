import { test, expect, resetServerState } from '../ci-fixtures'
import { settings } from '../helpers'

test.beforeEach(async () => {
  await resetServerState()
})

test('mcp tab exposes "add server" button', async ({ page }) => {
  await settings.open(page)
  await settings.openTab(page, 'mcp')

  await expect(page.locator('[data-testid="settings-tab-mcp"]')).toHaveAttribute(
    'data-active',
    'true',
  )

  // The Add server button sits below any existing MCP entries.
  await expect(page.getByTestId('settings-mcp-add-server')).toBeVisible({ timeout: 5_000 })
})
