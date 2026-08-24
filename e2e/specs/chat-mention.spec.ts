import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  await resetServerState()
})

// Universal: works in both fake and real modes (real Electron exposes mention
// popup the same way).
test('typing @ opens the mention popup', async ({ page }) => {
  await setFakeScript('verbatim-echo')
  await chat.openNewChat(page)

  const input = page.getByPlaceholder('Ask anything, @ to mention files, / to use commands...')
  await input.click()
  await input.type('Look at @')

  // The mention popup is mounted near the textarea.
  await expect(page.getByTestId('mention-popup')).toBeVisible({ timeout: 5_000 })
})

// Fake-only: the assertion `ping-1234` echoes back depends on the verbatim-echo
// script. Real providers won't echo verbatim.
test('verbatim-echo round-trips message text into the assistant reply', async ({ page }) => {
  fakeOnly()
  await setFakeScript('verbatim-echo')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'ping-1234')
  await waitForStreamIdle(page)

  await expect(page.locator('[data-testid="message-assistant"]').first()).toContainText(/ping-1234/)
})
