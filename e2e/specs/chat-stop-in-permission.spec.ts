import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

// Aborting while waiting on permission must clean up the pending approval and
// return the stream to idle. The fake session's `rejectAllPending` runs in
// abort()/dispose() — this guards against regressions where stop leaves the
// permission dialog or stream stuck.
test('stop button aborts the stream while permission dialog is open', async ({ page }) => {
  await setFakeScript('blocking-permission')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'wait for me')

  // Permission dialog must show first.
  await expect(page.locator('[data-testid="permission-dialog"]').first()).toBeVisible({
    timeout: 10_000,
  })

  // Click stop instead of allow/deny.
  await chat.stopStream(page)
  await waitForStreamIdle(page)

  const state = await page.evaluate(() => window.__operon?.streamState() ?? 'idle')
  expect(state).toBe('idle')
})
