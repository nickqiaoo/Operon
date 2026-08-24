import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

test('claude-multi-turn: assistant references prior user input on turn 2', async ({ page }) => {
  await setFakeScript('claude-multi-turn')
  await chat.openNewChat(page)

  await chat.sendMessage(page, 'hello')
  await waitForStreamIdle(page)
  await expect(page.locator('[data-testid="message-assistant"]').first()).toContainText(/your name/i)

  await chat.sendMessage(page, 'Alice')
  await waitForStreamIdle(page)

  const allAssistant = page.locator('[data-testid="message-assistant"]')
  await expect(allAssistant).toHaveCount(2)
  await expect(allAssistant.last()).toContainText(/Alice/i)
})
