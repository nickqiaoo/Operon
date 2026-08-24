import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

// Steer button appears when stream is active AND provider supports injection.
// Fake provider has features.injection: true. Test sends a long-running
// stream, types a follow-up, clicks Steer, and verifies the instruction stays
// in the composer-side tray before it is archived into the completed turn.
test('chat-steer: injects a follow-up while stream is active', async ({ page }) => {
  await setFakeScript('long-running')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'long stream please')

  // Wait until stream is active so the Steer button appears.
  await expect
    .poll(() => page.evaluate(() => window.__operon?.streamState() ?? 'idle'), { timeout: 5_000 })
    .toBe('streaming')

  const steerBtn = page.getByTestId('chat-steer')
  await expect(steerBtn).toBeVisible()

  // Type into the chat input then click Steer.
  const input = page.getByPlaceholder('Ask anything, @ to mention files, / to use commands...')
  await input.click()
  await input.fill('actually focus on edge cases')
  await steerBtn.click()

  const steerTray = page.getByTestId('steer-tray')
  await expect(steerTray).toBeVisible()
  await expect(steerTray.getByTestId('steer-tray-item')).toContainText(/edge cases/i)
  await expect(steerTray.getByTestId('steer-tray-item')).toHaveAttribute('data-status', 'sent')
  await expect(page.getByTestId('message-list').getByTestId('steer-tray')).toHaveCount(0)

  // Wait for the original long-running stream to finish naturally.
  await waitForStreamIdle(page, 30_000)

  // After stream ends, the same durable steer is shown once under the turn's user message.
  await expect(steerTray).toHaveCount(0)
  const userTurn = page.locator('[data-message-item-role="user"]').filter({ hasText: 'long stream please' })
  await expect(userTurn.getByTestId('archived-steer')).toHaveCount(1)
  await expect(userTurn.getByTestId('archived-steer')).toContainText(/edge cases/i)
})
