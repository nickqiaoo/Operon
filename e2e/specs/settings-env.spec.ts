import { test, expect, resetServerState } from '../ci-fixtures'
import { settings } from '../helpers'

test.beforeEach(async () => {
  await resetServerState()
})

test('env tab renders save button', async ({ page }) => {
  await settings.open(page)
  await settings.openTab(page, 'env')

  await expect(page.locator('[data-testid="settings-tab-env"]')).toHaveAttribute(
    'data-active',
    'true',
  )

  await expect(page.getByTestId('settings-env-save')).toBeVisible({ timeout: 5_000 })
})
