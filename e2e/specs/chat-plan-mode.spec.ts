import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState, approvePermission } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

// PlanRenderer triggers when tool name is `ExitPlanMode` (Claude) or
// `exit_plan_mode` (Gemini). It pauses on tool-approval-request, exposing
// allow/deny buttons. Allow triggers a "Implement the plan." follow-up
// message handled by useChatSessionControls — see plan-approval-* path.

test('claude-plan: ExitPlanMode renders Plan card with permission actions', async ({ page }) => {
  await setFakeScript('claude-plan')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'plan a refactor')

  // Plan card should render with the markdown title
  await expect(page.locator('[data-slot="plan"]').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-slot="plan-title"]').first()).toContainText(/Refactor auth module/i)

  // Permission dialog (allow/deny) should be present inside the plan card
  await expect(page.locator('[data-testid="permission-dialog"]').first()).toBeVisible()

  await approvePermission(page, 'allow')
  await waitForStreamIdle(page)

  // After allow, the script emits closing text "Starting implementation now."
  await expect(page.locator('[data-testid="message-assistant"]').last()).toContainText(/Starting implementation/i)
})

test('gemini-plan: exit_plan_mode renders Plan card with feedback flow', async ({ page }) => {
  await setFakeScript('gemini-plan')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'plan the migration')

  await expect(page.locator('[data-slot="plan"]').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-slot="plan-title"]').first()).toContainText(/Migration plan/i)

  await expect(page.locator('[data-testid="permission-dialog"]').first()).toBeVisible()
  await approvePermission(page, 'allow')
  await waitForStreamIdle(page)

  await expect(page.locator('[data-testid="message-assistant"]').last()).toContainText(/Implementing the plan/i)
})
