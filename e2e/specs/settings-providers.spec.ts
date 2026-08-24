import { test, expect, resetServerState } from '../ci-fixtures'
import { settings } from '../helpers'

test.beforeEach(async () => {
  await resetServerState()
})

test('providers tab is reachable and renders', async ({ page }) => {
  await settings.open(page)
  await settings.openTab(page, 'providers')
  await expect(page.locator('[data-testid="settings-tab-providers"]')).toHaveAttribute(
    'data-active',
    'true',
  )

  // The providers panel itself always renders some heading or input.
  // We don't assert specific provider text since the list is dynamic; the
  // panel being mounted (no error) is the contract this spec defends.
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
})
