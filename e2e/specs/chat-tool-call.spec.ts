import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

const cases = [
  { script: 'claude-tool-call', toolName: 'Read' },
  { script: 'codex-tool-call', toolName: 'shell' },
  { script: 'opencode-tool-call', toolName: 'read' },
] as const

for (const { script, toolName } of cases) {
  test(`${script}: tool invocation renders with tool name and result`, async ({ page }) => {
    await setFakeScript(script)
    await chat.openNewChat(page)
    await chat.sendMessage(page, `please run ${toolName}`)
    await waitForStreamIdle(page)

    // tool name appears in the rendered tool block
    await expect(page.getByTestId('tool-name').filter({ hasText: toolName }).first()).toBeVisible({
      timeout: 10_000,
    })

    // assistant message shows up
    await expect(page.locator('[data-testid="message-assistant"]').first()).toBeVisible()
  })
}
