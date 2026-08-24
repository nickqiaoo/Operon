import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState, approvePermission } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

test('claude-permission: approval flow streams tool result on allow', async ({ page }) => {
  await setFakeScript('claude-permission')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'run a Bash command for me')

  await expect(page.locator('[data-testid="permission-dialog"]').first()).toBeVisible({
    timeout: 10_000,
  })

  await approvePermission(page, 'allow')
  await waitForStreamIdle(page)

  // After permission allow, the script emits a tool-result and a closing
  // "Command finished." text part. Each text part renders as its own
  // <Message data-testid="message-assistant"> element, so check the LAST one.
  await expect(page.locator('[data-testid="message-assistant"]').last()).toContainText(
    /Command finished/i,
  )
})

test('codex-permission: deny short-circuits the tool', async ({ page }) => {
  await setFakeScript('codex-permission')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'apply a patch')

  await expect(page.locator('[data-testid="permission-dialog"]').first()).toBeVisible({
    timeout: 10_000,
  })

  await approvePermission(page, 'deny')
  await waitForStreamIdle(page)

  // Script's deny branch finishes without emitting "Command finished" text;
  // assistant message should still be present (showing the pre-approval text).
  await expect(page.locator('[data-testid="message-assistant"]').first()).toBeVisible()
})
