import { test, expect, waitForStreamIdle } from '../ci-fixtures'

/**
 * Handwritten reference spec for the `ci` Playwright project.
 *
 * Goal: prove the full Layer-4 loop works end-to-end with the bundled Fake
 * runtime — new chat → pick Fake provider → send a message → assistant reply
 * appears → stream returns to idle. Future Agent-generated specs should follow
 * the same shape:
 *   1. set up Fake script (default works for trivial cases)
 *   2. drive UI through data-testid selectors
 *   3. wait via window.__operon, not waitForTimeout
 *   4. assert structural state, not exact text
 */
test('Fake provider responds to a message', async ({ page }) => {
  await page.getByTestId('new-tab-button').click()
  await page.getByTestId('new-chat-menuitem').hover()
  await page.getByTestId('provider-option-fake').click()

  const input = page.getByPlaceholder(
    'Ask anything, @ to mention files, / to use commands...',
  )
  await input.fill('hello fake runtime')
  await page.getByRole('button', { name: 'Submit' }).click()

  await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible()

  await waitForStreamIdle(page)

  const assistant = page.locator('[data-testid="message-assistant"]').first()
  await expect(assistant).toBeVisible()
  await expect(assistant).toContainText(/fake runtime/i)

  const tabs = await page.evaluate(() => window.__operon?.tabs() ?? [])
  expect(tabs.length).toBeGreaterThan(0)
  expect(tabs[0]?.providerId).toBe('fake')
})
