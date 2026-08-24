import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

// ToolInputDiff renders when toolName matches edit/write/replace/patch.
// Each script emits a tool-call with file_path so the diff viewer shows
// the file path and the diff content.

const cases = [
  { script: 'claude-edit-diff', toolName: 'Edit', filePathFragment: '/tmp/example.ts' },
  { script: 'claude-write-diff', toolName: 'Write', filePathFragment: '/tmp/new-file.ts' },
  { script: 'codex-patch-diff', toolName: 'patch', filePathFragment: '/tmp/example.ts' },
] as const

for (const { script, toolName, filePathFragment } of cases) {
  test(`${script}: ${toolName} expands to show file path in diff`, async ({ page }) => {
    await setFakeScript(script)
    await chat.openNewChat(page)
    await chat.sendMessage(page, `apply ${toolName}`)
    await waitForStreamIdle(page)

    const toolButton = page.getByTestId('tool-name').filter({ hasText: toolName }).first()
    await expect(toolButton).toBeVisible({ timeout: 10_000 })

    // Tools render collapsed; click to expand and reveal ToolInputDiff content.
    await toolButton.click()
    await expect(page.getByText(filePathFragment).first()).toBeVisible({ timeout: 5_000 })
  })
}
