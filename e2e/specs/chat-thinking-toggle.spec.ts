import { test, expect, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  await resetServerState()
})

test('thinking-effort toggle cycles through fake provider levels', async ({ page }) => {
  await setFakeScript('verbatim-echo')
  await chat.openNewChat(page)

  const btn = page.getByTestId('chat-thinking-toggle').first()
  await expect(btn).toBeVisible({ timeout: 5_000 })

  const initial = ((await btn.textContent()) ?? '').trim()
  await btn.click()
  const next = ((await btn.textContent()) ?? '').trim()
  // Cycling through low / medium / high produces a different label.
  expect(next).not.toBe(initial)
})
