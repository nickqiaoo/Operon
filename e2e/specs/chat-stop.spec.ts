import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import type { Page } from '@playwright/test'
import { chat, chatInput } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

test('long-running stream can be stopped from the chat input', async ({ page }) => {
  await setFakeScript('long-running')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'go for a long while')

  // Wait until streaming starts.
  await expect
    .poll(() => page.evaluate(() => window.__operon?.streamState() ?? 'idle'), { timeout: 5_000 })
    .toBe('streaming')

  await chat.stopStream(page)
  await waitForStreamIdle(page)

  // Stream is back to idle.
  const state = await page.evaluate(() => window.__operon?.streamState() ?? 'idle')
  expect(state).toBe('idle')
})

// `blocking-permission` never finishes on its own, so reaching idle proves Escape stopped it.
async function startHeldReply(page: Page) {
  await setFakeScript('blocking-permission')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'wait for me')
  await expect(page.locator('[data-testid="permission-dialog"]').first()).toBeVisible({ timeout: 10_000 })
}

const streamState = (page: Page) => page.evaluate(() => window.__operon?.streamState() ?? 'idle')

test('Escape stops the reply right after clicking send', async ({ page }) => {
  await startHeldReply(page)
  // Window-level Escape listeners (the Session panel) skip events marked as handled.
  await page.evaluate(() => {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.body.dataset.escapeHandled = String(e.defaultPrevented)
    }, { once: true })
  })
  await page.keyboard.press('Escape')
  await waitForStreamIdle(page)
  expect(await streamState(page)).toBe('idle')
  await expect(page.locator('body')).toHaveAttribute('data-escape-handled', 'true')
})

test('Escape in the chat input stops the reply and keeps the draft', async ({ page }) => {
  await startHeldReply(page)
  const input = chatInput(page)
  await input.fill('draft to keep')
  await page.keyboard.press('Escape')
  await waitForStreamIdle(page)
  expect(await streamState(page)).toBe('idle')
  await expect(input).toHaveValue('draft to keep')
})

test('Escape stops the reply after clicking the message list, without a focus ring', async ({ page }) => {
  await startHeldReply(page)
  await page.locator('[data-testid="message-user"]').first().click()
  const focusedList = page.locator('[data-slot="message-scroller-viewport"]:focus')
  await expect(focusedList).toHaveCount(1)

  await page.keyboard.press('Escape')
  // Chromium only draws the ring once a key has been pressed on the focused list.
  await expect(focusedList).toHaveCSS('outline-style', 'none')
  await waitForStreamIdle(page)
  expect(await streamState(page)).toBe('idle')
})

test('Escape closes an open slash menu before it stops the reply', async ({ page }) => {
  await startHeldReply(page)
  const input = chatInput(page)
  await input.click()
  await input.pressSequentially('/')
  const menu = page.getByTestId('slash-command-menu')
  await expect(menu).toBeVisible({ timeout: 5_000 })

  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  expect(await streamState(page)).toBe('streaming')

  await page.keyboard.press('Escape')
  await waitForStreamIdle(page)
  expect(await streamState(page)).toBe('idle')
})

test('Escape does nothing while no reply is running', async ({ page }) => {
  await setFakeScript('verbatim-echo')
  await chat.openNewChat(page)
  const input = chatInput(page)
  await input.fill('still here')
  await page.keyboard.press('Escape')
  await expect(input).toHaveValue('still here')
  await expect(page.locator('[data-testid="message-user"]')).toHaveCount(0)
})
