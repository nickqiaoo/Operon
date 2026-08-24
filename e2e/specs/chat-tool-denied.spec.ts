import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState, approvePermission } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

// tool-output-denied is emitted after the user denies a tool. The renderer
// should show a "Denied" state on the tool block (label + icon).
test('tool-output-denied renders denied state on the tool block', async ({ page }) => {
  await setFakeScript('tool-output-denied')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'destructive op')

  await expect(page.locator('[data-testid="permission-dialog"]').first()).toBeVisible({
    timeout: 10_000,
  })
  await approvePermission(page, 'deny')
  await waitForStreamIdle(page)

  // Tool name still rendered, with denied state on the tool invocation.
  const toolBtn = page.getByTestId('tool-name').filter({ hasText: 'DestructiveOp' }).first()
  await expect(toolBtn).toBeVisible()

  // CompactToolCall sets data-tool-state on the trigger when the server emits
  // tool-output-denied for this tool call.
  await expect(page.locator('[data-testid="tool-invocation"][data-tool-state="output-denied"]').first())
    .toBeVisible({ timeout: 5_000 })
})
