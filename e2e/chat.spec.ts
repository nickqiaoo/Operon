import { test, expect } from './fixtures'
import { PROVIDERS, newChat, sendMessage, waitForResponse } from './helpers'

for (const provider of PROVIDERS) {
  test.describe(`Chat [${provider.label}]`, () => {
    test('sends message and gets response', async ({ appPage: page }) => {
      await newChat(page, provider)
      await sendMessage(page, 'say hi in one sentence')
      await waitForResponse(page)
    })
  })
}
