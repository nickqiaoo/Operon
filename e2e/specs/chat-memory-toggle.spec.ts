import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState, approvePermission } from '../ci-fixtures'
import { chat } from '../helpers'

/**
 * Ported from the dev-only `e2e/memory-toggle.spec.ts` to run in the ci project
 * with the fake-runtime permission flow. Verifies that a permission dialog
 * appears mid-stream and that the user's allow decision unblocks the script.
 */

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

test('blocking-permission scenario completes after user allows', async ({ page }) => {
  await setFakeScript('blocking-permission')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'go ahead')

  await expect(page.locator('[data-testid="permission-dialog"]').first()).toBeVisible({
    timeout: 10_000,
  })
  await approvePermission(page, 'allow')
  await waitForStreamIdle(page)

  const state = await page.evaluate(() => window.__operon?.streamState() ?? 'idle')
  expect(state).toBe('idle')
})
