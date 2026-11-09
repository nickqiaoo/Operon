import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

const tallPrompt = (label: string) => Array.from({ length: 45 }, (_, i) => `${label} line ${i}`).join('\n')

// A prompt taller than the viewport stays anchored at its first line, away from the end.
test('opening a waiting chat from the inbox lands on its newest message', async ({ page }) => {
  await chat.openNewChat(page)
  await chat.sendMessage(page, tallPrompt('first'))
  await waitForStreamIdle(page)
  await setFakeScript('blocking-permission')
  await chat.sendMessage(page, tallPrompt('second'))
  await expect(page.locator('[data-testid="permission-dialog"]').first()).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'Inbox', exact: true }).first().click()
  await page.locator('[role="button"]', { hasText: 'Waiting for approval' }).first().click()

  const scroller = page.locator('[aria-hidden="false"] [data-conversation-scroller]')
  await expect(scroller).toBeVisible()
  await expect
    .poll(() => scroller.evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop)))
    .toBeLessThanOrEqual(2)
  // Held there once the transcript has settled.
  await page.waitForTimeout(500)
  expect(await scroller.evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThanOrEqual(2)
})
