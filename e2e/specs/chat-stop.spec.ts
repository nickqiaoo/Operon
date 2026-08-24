import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

test('long-running stream can be stopped from the chat input', async ({ page }) => {
  await setFakeScript('long-running')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'go for a long while')

  // Wait until streaming starts.
  await expect
    .poll(() => page.evaluate(() => window.__operon?.streamState() ?? 'idle'), { timeout: 5_000 })
    .toBe('streaming')

  await chat.stopStream(page)
  await waitForStreamIdle(page)

  // Stream is back to idle.
  const state = await page.evaluate(() => window.__operon?.streamState() ?? 'idle')
  expect(state).toBe('idle')
})
