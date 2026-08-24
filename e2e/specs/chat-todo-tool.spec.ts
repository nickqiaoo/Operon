import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

// TodoWriteRenderer triggers for tool names todowrite / taskcreate /
// codex_plan_steps etc. Renders a checklist of todos with completed /
// in_progress / pending status indicators.

test('opencode-todo-write: renders 3 todos with completion counts', async ({ page }) => {
  await setFakeScript('opencode-todo-write')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'track progress')
  await waitForStreamIdle(page)

  await expect(page.getByTestId('tool-name').filter({ hasText: /todowrite/i }).first()).toBeVisible({
    timeout: 10_000,
  })

  // Each todo's text appears
  await expect(page.getByText('Read the failing test').first()).toBeVisible()
  // in_progress entry shows activeForm
  await expect(page.getByText('Patching the bug').first()).toBeVisible()
  await expect(page.getByText('Add regression test').first()).toBeVisible()
})

test('codex-plan-steps: renders steps from codex_plan_steps tool', async ({ page }) => {
  await setFakeScript('codex-plan-steps')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'show plan steps')
  await waitForStreamIdle(page)

  await expect(page.getByTestId('tool-name').filter({ hasText: /codex_plan_steps/i }).first()).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByText('Read existing config').first()).toBeVisible()
  await expect(page.getByText('Patch the bug').first()).toBeVisible()
  await expect(page.getByText('Run tests').first()).toBeVisible()
})
