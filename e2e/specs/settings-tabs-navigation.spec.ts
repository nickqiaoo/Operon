import { test, expect, resetServerState } from '../ci-fixtures'
import { settings } from '../helpers'

test.beforeEach(async () => {
  await resetServerState()
})

test('settings opens, switches across multiple tabs, and closes', async ({ page }) => {
  await settings.open(page)

  // Walk through the canonical tabs that always render in the test build.
  await settings.openTab(page, 'appearance')
  await expect(page.locator('[data-testid="settings-tab-appearance"]')).toHaveAttribute(
    'data-active',
    'true',
  )

  await settings.openTab(page, 'mcp')
  await expect(page.locator('[data-testid="settings-tab-mcp"]')).toHaveAttribute(
    'data-active',
    'true',
  )

  await settings.openTab(page, 'env')
  await expect(page.locator('[data-testid="settings-tab-env"]')).toHaveAttribute(
    'data-active',
    'true',
  )

  await settings.close(page)
  await expect(page.getByTestId('settings-dialog')).not.toBeVisible()
})
