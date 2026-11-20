import { test, expect, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  await resetServerState()
})

test('the tab strip has no "+" until a tab is open', async ({ page }) => {
  await expect(page.getByTestId('new-tab-button')).toHaveCount(0)
  await chat.openNewChat(page)
  await expect(page.getByTestId('new-tab-button')).toBeVisible()
})

test('new-tab Chat submenu lists the fake provider', async ({ page }) => {
  await chat.openNewChat(page)
  await page.getByTestId('new-tab-button').click()
  // "New Chat" is a submenu trigger; hover to reveal the provider options.
  await page.getByTestId('new-chat-menuitem').hover()
  await expect(page.getByTestId('provider-option-fake')).toBeVisible()
})

test('selecting fake provider from the Chat submenu creates a tab tagged with that providerId', async ({ page }) => {
  await chat.openNewChat(page)
  await page.getByTestId('new-tab-button').click()
  await page.getByTestId('new-chat-menuitem').hover()
  await page.getByTestId('provider-option-fake').click()

  const tabs = await page.evaluate(() => window.__operon?.tabs() ?? [])
  expect(tabs.length).toBe(2)
  expect(tabs.every((t) => t.providerId === 'fake')).toBe(true)
})
