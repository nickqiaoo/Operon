import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

const STYLES = ['claude', 'codex', 'gemini', 'kimi', 'opencode', 'custom'] as const

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

for (const style of STYLES) {
  test(`${style}-style: text streaming completes and metadata is preserved`, async ({ page }) => {
    await setFakeScript(`${style}-text-only`)
    await chat.openNewChat(page)
    await chat.sendMessage(page, `hello ${style}`)
    await waitForStreamIdle(page)

    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible()
    await expect(page.locator('[data-testid="message-assistant"]').first()).toBeVisible()

    const tabs = await page.evaluate(() => window.__operon?.tabs() ?? [])
    expect(tabs.length).toBeGreaterThan(0)
    expect(tabs[0]?.providerId).toBe('fake')
  })
}
