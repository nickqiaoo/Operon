import { test, expect, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  await resetServerState()
})

test('mode toggle and fast toggle are reachable when present', async ({ page }) => {
  await setFakeScript('verbatim-echo')
  await chat.openNewChat(page)

  const modeBtn = page.getByTestId('chat-mode-toggle')
  if ((await modeBtn.count()) > 0) {
    await modeBtn.first().click()
  }

  const fastBtn = page.getByTestId('chat-fast-toggle')
  if ((await fastBtn.count()) > 0) {
    await fastBtn.first().click()
  }

  // Sanity: input still focused and accepts text after toggling.
  const input = page.getByPlaceholder('Ask anything, @ to mention files, / to use commands...')
  await input.fill('still works')
  await expect(input).toHaveValue('still works')
})
