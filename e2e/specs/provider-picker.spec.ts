import { test, expect, resetServerState } from '../ci-fixtures'

test.beforeEach(async () => {
  await resetServerState()
})

test('new-tab Chat submenu lists the fake provider', async ({ page }) => {
  await page.getByTestId('new-tab-button').click()
  // "New Chat" is a submenu trigger; hover to reveal the provider options.
  await page.getByTestId('new-chat-menuitem').hover()
  await expect(page.getByTestId('provider-option-fake')).toBeVisible()
})

test('selecting fake provider from the Chat submenu creates a tab tagged with that providerId', async ({ page }) => {
  await page.getByTestId('new-tab-button').click()
  await page.getByTestId('new-chat-menuitem').hover()
  await page.getByTestId('provider-option-fake').click()

  const tabs = await page.evaluate(() => window.__operon?.tabs() ?? [])
  expect(tabs.some((t) => t.providerId === 'fake')).toBe(true)
})
