import type { Page } from '@playwright/test'
import { test, expect, fakeOnly } from '../ci-fixtures'

const SERVER = `http://127.0.0.1:${process.env.PW_CI_SERVER_PORT ?? 4100}`
const TITLE = 'Paged history'
/** More than two client pages (10 each), so opening it loads the newest page and then older ones. */
const MESSAGE_COUNT = 24

const messages = Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
  id: `paged-${index}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  parts: [{ type: 'text', text: index % 2 === 0 ? `Question ${index}` : `Answer ${index}` }],
}))

async function seedChat(): Promise<void> {
  const reset = await fetch(`${SERVER}/api/test/db/reset`, { method: 'POST' })
  const { workspaceId } = (await reset.json()) as { workspaceId: number }
  const created = await fetch(`${SERVER}/api/chat-history`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: TITLE, tp: 'chat', workspaceId, providerId: 'fake', messages }),
  })
  expect(created.ok).toBe(true)
  await fetch(`${SERVER}/api/test/fake/reset`, { method: 'POST' })
}

const renderedIds = (page: Page) =>
  page.locator('[data-message-id^="paged-"]').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-message-id')),
  )

test.beforeEach(() => {
  fakeOnly()
})

// Opening a conversation loads its newest page, and older pages follow at once while
// the list cannot scroll yet. That follow-up used to prepend to the list the caller
// had rendered — still `[]` right after the first page landed — so the older page
// replaced the newest one, and the transcript ended mid-conversation.
test('reopening a paged conversation keeps its newest messages and leaves no gap', async ({ page }) => {
  await seedChat()
  await page.goto('/')
  await page.getByText(TITLE).first().click()

  await expect(page.locator('[data-message-id="paged-23"]')).toHaveCount(1)
  // Let the older-page loads triggered by the short viewport settle.
  await page.waitForTimeout(1500)

  const ids = await renderedIds(page)
  expect(ids.at(-1)).toBe(`paged-${MESSAGE_COUNT - 1}`)
  const first = Number(ids[0]?.replace('paged-', ''))
  expect(ids).toEqual(Array.from({ length: MESSAGE_COUNT - first }, (_, offset) => `paged-${first + offset}`))
})
