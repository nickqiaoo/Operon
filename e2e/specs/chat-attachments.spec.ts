import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

// PromptInput renders a hidden <input type="file"> bound to the attachment
// button. We can attach files directly to that input — bypassing the OS file
// dialog — and verify the attachment is mounted in the input area.

test('chat-attachments: attaching a file shows it in the input row', async ({ page }) => {
  await setFakeScript('verbatim-echo')
  await chat.openNewChat(page)

  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.setInputFiles({
    name: 'hello.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('greetings from playwright'),
  })

  // Text-file attachment chip previews the content inline.
  await expect(page.getByText('greetings from playwright').first()).toBeVisible({ timeout: 5_000 })
  // And exposes a Remove button.
  await expect(page.getByRole('button', { name: /^Remove$/ }).first()).toBeVisible()
})

test('chat-attachments: sending a message with an attachment keeps it in the user message', async ({ page }) => {
  await setFakeScript('verbatim-echo')
  await chat.openNewChat(page)

  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.setInputFiles({
    name: 'note.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# note from test'),
  })
  await expect(page.getByText(/note from test/).first()).toBeVisible({ timeout: 5_000 })

  await chat.sendMessage(page, 'see attached')
  await waitForStreamIdle(page)

  // User message bubble carries the attachment preview alongside the typed text.
  const userMsg = page.locator('[data-testid="message-user"]').last()
  await expect(userMsg).toContainText(/see attached/i)
  await expect(userMsg.getByText(/note from test/)).toBeVisible()
})
