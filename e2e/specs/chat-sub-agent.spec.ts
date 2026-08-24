import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

// SubAgentRenderer triggers for an `Agent` tool with childParts (linked via
// callProviderMetadata.parentToolCallId on the children). The script emits
// 1 parent Agent + 2 children (Read, Bash).

test('SubAgent renders parent Agent task with child step count', async ({ page }) => {
  await setFakeScript('claude-sub-agent')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'investigate failing test')
  await waitForStreamIdle(page)

  // Parent task title + Agent badge
  await expect(page.getByText('Investigate the failing test').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(/^Agent$/).first()).toBeVisible()

  // Child step count: "2 steps"
  await expect(page.getByText(/^2 steps$/).first()).toBeVisible()
})

test('SubAgent expands to reveal child tool calls', async ({ page }) => {
  await setFakeScript('claude-sub-agent')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'investigate again')
  await waitForStreamIdle(page)

  // Click the parent Agent task to expand.
  await page.getByText('Investigate the failing test').first().click()

  // Child tool names appear inside the expanded task content.
  await expect(page.getByText(/^Read$/).first()).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText(/^Bash$/).first()).toBeVisible()
})
