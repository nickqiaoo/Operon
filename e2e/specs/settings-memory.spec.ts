import { test, expect, resetServerState } from '../ci-fixtures'
import { settings } from '../helpers'

test.beforeEach(async () => {
  await resetServerState()
})

test('env tab is reachable from settings', async ({ page }) => {
  // Note: the memory tab is gated by the build-time __ENABLE_MEMORY__ flag.
  // The vite test-renderer leaves it as `true` by default, so we don't assert
  // its presence either way — `settings-tabs-navigation` already covers the
  // common navigation contract.
  await settings.open(page)
  await settings.openTab(page, 'env')
  await expect(page.locator('[data-testid="settings-tab-env"]')).toHaveAttribute(
    'data-active',
    'true',
  )
})
