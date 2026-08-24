import { test, expect, resetServerState } from '../ci-fixtures'
import { settings } from '../helpers'

test.beforeEach(async () => {
  await resetServerState()
})

test('appearance tab toggles theme and persists active state', async ({ page }) => {
  await settings.open(page)
  await settings.openTab(page, 'appearance')

  // Switch to dark.
  await page.getByTestId('settings-appearance-theme-dark').click()
  await expect(page.getByTestId('settings-appearance-theme-dark')).toHaveAttribute(
    'data-active',
    'true',
  )
  // The HTML root should pick up `dark` class via applyTheme().
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(true)

  // Back to light.
  await page.getByTestId('settings-appearance-theme-light').click()
  await expect(page.getByTestId('settings-appearance-theme-light')).toHaveAttribute(
    'data-active',
    'true',
  )
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(false)
})
