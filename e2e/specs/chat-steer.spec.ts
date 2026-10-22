import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async ({ page }) => {
  fakeOnly()
  await resetServerState()
  // Fake has no CLI to discover; make the scripted test provider selectable.
  await page.route('**/api/ai/providers', async (route) => {
    const response = await route.fetch()
    const providers: Array<{ id: string; available: boolean }> = await response.json()
    await route.fulfill({
      response,
      json: providers.map((provider) => provider.id === 'fake' ? { ...provider, available: true } : provider),
    })
  })
  await page.reload()
})

// Steer button appears when stream is active AND provider supports injection.
// Fake provider has features.injection: true. Test sends a long-running
// stream, types a follow-up, sends it, and verifies the instruction stays
// in the composer-side tray before it is archived into the completed turn.
for (const action of ['button', 'enter'] as const) {
  test(`chat-steer: injects a follow-up via ${action} while stream is active`, async ({ page }) => {
    await setFakeScript('long-running')
    await chat.openNewChat(page)
    await chat.sendMessage(page, 'long stream please')

    // Wait until stream is active so the Steer button appears.
    await expect
      .poll(() => page.evaluate(() => window.__operon?.streamState() ?? 'idle'), { timeout: 5_000 })
      .toBe('streaming')

    const steerBtn = page.getByTestId('chat-steer')
    await expect(steerBtn).toBeVisible()

    // Enter must respect editing and IME confirmation before it sends a steer.
    const input = page.getByPlaceholder('Ask anything, @ to mention files, / to use commands...')
    await input.click()
    if (action === 'enter') {
      await input.press('Enter')
      await input.fill('first line')
      await input.press('Shift+Enter')
      await expect(input).toHaveValue('first line\n')
      await input.dispatchEvent('compositionstart')
      await input.dispatchEvent('keydown', { key: 'Enter' })
      await expect(input).toHaveValue('first line\n')
      // Some IMEs fire compositionend just before the confirming Enter.
      await input.evaluate((element) => {
        element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      await expect(input).toHaveValue('first line\n')
      await expect(page.getByTestId('steer-tray')).toHaveCount(0)
    }
    await input.fill('actually focus on edge cases')
    if (action === 'enter') await input.press('Enter')
    else await steerBtn.click()

    const steerTray = page.getByTestId('steer-tray')
    await expect(steerTray).toBeVisible()
    await expect(steerTray.getByTestId('steer-tray-item')).toContainText(/edge cases/i)
    await expect(steerTray.getByTestId('steer-tray-item')).toHaveAttribute('data-status', 'sent')
    await expect(page.getByTestId('message-list').getByTestId('steer-tray')).toHaveCount(0)
    await expect(input).toHaveValue('')

    // Wait for the original long-running stream to finish naturally.
    await waitForStreamIdle(page, 30_000)
    await expect(page.getByTestId('message-assistant').first()).toContainText('tick-20')

    // After stream ends, the same durable steer is shown once under the turn's user message.
    await expect(steerTray).toHaveCount(0)
    const userTurn = page.locator('[data-message-item-role="user"]').filter({ hasText: 'long stream please' })
    await expect(userTurn.getByTestId('archived-steer')).toHaveCount(1)
    await expect(userTurn.getByTestId('archived-steer')).toContainText(/edge cases/i)
  })
}

test('chat-steer: Enter preserves the draft while a steer is still being sent', async ({ page }) => {
  await setFakeScript('blocking-permission')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'keep working')
  await expect(page.getByTestId('chat-steer')).toBeVisible()

  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let injectionCount = 0
  await page.route('**/api/ai/inject', async (route) => {
    injectionCount += 1
    await gate
    await route.continue()
  })
  const input = page.getByTestId('chat-input')
  try {
    await input.fill('first follow-up')
    await input.press('Enter')
    await expect(page.getByTestId('steer-tray-item')).toHaveAttribute('data-status', 'sending')
    await expect.poll(() => injectionCount).toBe(1)
    await input.fill('next follow-up')
    await input.press('Enter')
    await expect(input).toHaveValue('next follow-up')
    await expect(page.getByTestId('steer-tray-item')).toHaveCount(1)
    expect(injectionCount).toBe(1)
  } finally {
    release()
  }
  await expect(page.getByTestId('steer-tray-item')).toHaveAttribute('data-status', 'sent')
  await chat.stopStream(page)
  await waitForStreamIdle(page)
})
