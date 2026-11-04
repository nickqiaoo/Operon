import { test, expect, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  await resetServerState()
})

test('thinking-effort slider moves to the next level', async ({ page }) => {
  await setFakeScript('verbatim-echo')
  await chat.openNewChat(page)

  const btn = page.getByTestId('chat-thinking-toggle').first()
  await expect(btn).toBeVisible({ timeout: 5_000 })

  const initial = ((await btn.textContent()) ?? '').trim()
  await btn.click()
  // The popover holds a stepped slider; arrow keys move one level and commit it.
  const thumb = page.getByRole('slider', { name: 'Thinking level' })
  await expect(thumb).toBeVisible()
  await thumb.focus()
  const atMax = (await thumb.getAttribute('aria-valuenow')) === (await thumb.getAttribute('aria-valuemax'))
  await thumb.press(atMax ? 'ArrowLeft' : 'ArrowRight')
  await expect(btn).not.toHaveText(initial)
})
