import { test, expect, fakeOnly } from '../ci-fixtures'

const SERVER = `http://127.0.0.1:${process.env.PW_CI_SERVER_PORT ?? 4100}`
const TITLE = 'Steer with image'
/** 1×1 PNG, so the card has a real image to preview. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const messages = [
  { id: 'turn-1', role: 'user', parts: [{ type: 'text', text: 'Start the release' }] },
  {
    id: 'steer-1',
    role: 'user',
    metadata: { steer: true, turnMessageId: 'turn-1', deliveryMode: 'steer' },
    parts: [
      { type: 'file', url: PIXEL, mediaType: 'image/png', filename: 'screenshot.png' },
      { type: 'text', text: 'Look at this screenshot' },
    ],
  },
  {
    id: 'reply-1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Working on it.' },
      { type: 'data-injected-input', id: 'steer-1', data: { id: 'steer-1', text: 'Look at this screenshot' } },
      { type: 'text', text: 'I see the screenshot.' },
    ],
  },
]

test.beforeEach(() => {
  fakeOnly()
})

// A follow-up sent mid-turn shows where the agent read it, from the reply's
// `data-injected-input` part, which carries the text only. The steer row that holds
// the images is hidden in its favour, so the bubble used to drop them.
test('a follow-up read mid-turn keeps the images it was sent with', async ({ page }) => {
  const reset = await fetch(`${SERVER}/api/test/db/reset`, { method: 'POST' })
  const { workspaceId } = (await reset.json()) as { workspaceId: number }
  const created = await fetch(`${SERVER}/api/chat-history`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: TITLE, tp: 'chat', workspaceId, providerId: 'fake', messages }),
  })
  expect(created.ok).toBe(true)

  await page.goto('/')
  await page.getByText(TITLE).first().click()

  const steer = page.getByTestId('injected-steer')
  await expect(steer).toHaveCount(1)
  await expect(steer).toContainText('Look at this screenshot')
  const attachments = page.getByTestId('injected-steer-attachments')
  await expect(attachments).toHaveCount(1)
  await expect(attachments.locator('img')).toHaveCount(1)
})
