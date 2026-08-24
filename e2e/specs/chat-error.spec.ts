import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

const STYLES = ['claude', 'codex', 'gemini', 'kimi', 'opencode', 'custom'] as const

for (const style of STYLES) {
  test(`${style}-error: stream returns to idle after an error event`, async ({ page }) => {
    await setFakeScript(`${style}-error`)
    await chat.openNewChat(page)
    await chat.sendMessage(page, 'trigger error')
    await waitForStreamIdle(page)

    // The user message should still be visible — the failure is on the assistant side.
    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible()

    // Streaming has stopped: probe says idle.
    const state = await page.evaluate(() => window.__operon?.streamState() ?? 'idle')
    expect(state).toBe('idle')
  })
}
