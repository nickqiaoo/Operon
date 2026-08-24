import { test, expect } from './fixtures'
import { PROVIDERS, newChat, chatInput } from './helpers'

for (const provider of PROVIDERS) {
  test.describe(`UI Controls [${provider.label}]`, () => {
    test.beforeEach(async ({ appPage: page }) => {
      await newChat(page, provider)
    })

    test('slash command autocomplete', async ({ appPage: page }) => {
      // Must use pressSequentially (not fill) to trigger slash command detection
      await chatInput(page).pressSequentially('/comp')

      await expect(
        page.getByText('compact').first()
      ).toBeVisible({ timeout: 5_000 })
    })
  })
}
