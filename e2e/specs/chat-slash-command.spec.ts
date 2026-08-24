import { test, expect, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  await resetServerState()
})

test('typing / opens the slash command menu', async ({ page }) => {
  await setFakeScript('verbatim-echo')
  await chat.openNewChat(page)

  const input = page.getByPlaceholder('Ask anything, @ to mention files, / to use commands...')
  await input.click()
  await input.type('/')

  await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 5_000 })
})
