import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

const cases = [
  { script: 'claude-reasoning', text: /answer is 42/i },
  { script: 'codex-reasoning', text: /Final answer/i },
  { script: 'gemini-reasoning', text: /Result/i },
  { script: 'kimi-reasoning', text: /Plan executed/i },
  { script: 'opencode-reasoning', text: /OK/i },
  { script: 'custom-reasoning', text: /Done/i },
] as const

for (const { script, text } of cases) {
  test(`${script}: reasoning block renders alongside the final answer`, async ({ page }) => {
    await setFakeScript(script)
    await chat.openNewChat(page)
    await chat.sendMessage(page, 'think about this')
    await waitForStreamIdle(page)

    // Reasoning block is visible
    await expect(page.locator('[data-testid="reasoning"]').first()).toBeVisible({
      timeout: 10_000,
    })

    // Final answer appears in the assistant message
    await expect(page.locator('[data-testid="message-assistant"]').first()).toContainText(text)
  })
}
