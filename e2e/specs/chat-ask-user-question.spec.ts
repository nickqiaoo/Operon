import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

// AskUserQuestionRenderer triggers when toolName is `AskUserQuestion` (Claude)
// or `ask_user` (Gemini). It shows multi-question option lists with submit/
// cancel buttons. Selecting an option + submitting flows back as
// `addToolApprovalResponse` with answers, then the script emits its closing
// text quoting the picked answer.

test('AskUserQuestion: select option + submit echoes answer in reply', async ({ page }) => {
  await setFakeScript('claude-ask-user-question')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'ask me')

  // Question card renders with our two options.
  await expect(page.getByText('Which theme color do you prefer?')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Blue')).toBeVisible()
  await expect(page.getByText('Green')).toBeVisible()

  // Submit is initially disabled; clicking Blue enables it.
  const submit = page.getByTestId('ask-user-question-submit')
  await page.getByRole('button', { name: /^Blue/ }).click()
  await expect(submit).toBeEnabled()
  await submit.click()

  await waitForStreamIdle(page)

  // Closing text from the script quotes the answer back.
  await expect(page.locator('[data-testid="message-assistant"]').last()).toContainText(/Blue/)
})

test('AskUserQuestion: cancel short-circuits the tool', async ({ page }) => {
  await setFakeScript('claude-ask-user-question')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'ask me again')

  await expect(page.getByText('Which theme color do you prefer?')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('ask-user-question-cancel').click()

  await waitForStreamIdle(page)
  // Cancel hits the deny path — script ends without "You picked …".
  const lastAssistant = page.locator('[data-testid="message-assistant"]').last()
  await expect(lastAssistant).toBeVisible()
  await expect(lastAssistant).not.toContainText(/You picked/)
})
