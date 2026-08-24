import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

// segmentMessageParts groups 2+ consecutive compact-eligible tool parts into
// a single ToolCallGroup. The group summary is built by buildToolGroupSummary
// (e.g., 3 Read calls → "Read 3 files"). Expanding shows individual tools.
test('chat-tool-group: 3 sequential Reads collapse into one summary group', async ({ page }) => {
  await setFakeScript('compact-tool-group')
  await chat.openNewChat(page)
  await chat.sendMessage(page, 'read the files')
  await waitForStreamIdle(page)

  // Group summary collapsible: "Read 3 files"
  const groupSummary = page.getByText(/Read 3 files/i).first()
  await expect(groupSummary).toBeVisible({ timeout: 10_000 })

  // Expand the group to reveal the 3 inner Read entries.
  await groupSummary.click()
  await expect(page.getByTestId('tool-name').filter({ hasText: 'Read' })).toHaveCount(3)
})
