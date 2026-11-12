import type { Page } from '@playwright/test'
import type { Project, Workspace } from '../../src/stores/project-store'
import { test, expect, fakeOnly } from '../ci-fixtures'

const apiUrl = `http://127.0.0.1:${process.env.PW_CI_SERVER_PORT ?? 4100}/api`
const expandButton = (page: Page) => page.getByRole('button', { name: /^(Expand sidebar|展开侧栏)$/ })

async function collapseSidebar(page: Page) {
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await expect.poll(async () => (await page.getByTestId('left-sidebar').boundingBox())?.width).toBe(52)
}

async function seededProject(page: Page): Promise<Project> {
  const response = await page.request.get(`${apiUrl}/projects?include=workspaces`)
  const { projects } = await response.json() as { projects: Project[] }
  return projects[0]
}

test.beforeEach(() => fakeOnly())

test('the sidebar toggle stays mounted and stationary throughout the animation', async ({ page }) => {
  const toggle = page.getByTestId('toggle-sidebar')
  const original = await toggle.elementHandle()
  for (const expanded of ['false', 'true']) {
    await toggle.hover()
    const measurement = toggle.evaluate(async element => {
      const before = element.getBoundingClientRect()
      let maxMovement = 0
      let replaced = false
      let hidden = false
      await new Promise<void>(resolve => element.addEventListener('click', () => resolve(), { once: true }))
      const start = performance.now()
      while (performance.now() - start < 400) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        const rect = element.getBoundingClientRect()
        maxMovement = Math.max(maxMovement, Math.abs(rect.x - before.x), Math.abs(rect.y - before.y))
        replaced ||= document.querySelector('[data-testid="toggle-sidebar"]') !== element
        hidden ||= !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      }
      return { maxMovement, replaced, hidden }
    })
    await toggle.click()
    const result = await measurement
    expect(result).toEqual({ maxMovement: 0, replaced: false, hidden: false })
    await expect(toggle).toHaveAttribute('aria-expanded', expanded)
  }
  const before = await toggle.boundingBox()
  for (const name of ['Assistant', 'Board', 'Channels']) {
    await page.getByTestId('left-sidebar').getByRole('button', { name, exact: true }).click()
    expect(await original!.evaluate(element => element.isConnected)).toBe(true)
    expect(await toggle.boundingBox()).toEqual(before)
    await expect(page.getByTestId('toggle-sidebar')).toHaveCount(1)
    const title = await page.locator('.drag-region > span:visible').filter({ hasText: new RegExp(`^${name}$`) }).first().boundingBox()
    const button = await toggle.boundingBox()
    expect(title).not.toBeNull()
    expect(button).not.toBeNull()
    expect(Math.abs(button!.y + button!.height / 2 - title!.y - title!.height / 2)).toBeLessThan(0.1)
  }
})

test('navigation icons keep their size and alignment when the sidebar changes mode', async ({ page }, testInfo) => {
  const sidebar = page.getByTestId('left-sidebar')
  const measure = () => sidebar.evaluate(element => {
    const labels = ['Assistant', 'Board', 'Channels', 'Workflow', 'Plugins', 'Schedule', 'Settings']
    return labels.map(label => {
      const button = element.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
      const icon = button.querySelector('svg')!.getBoundingClientRect()
      return { label, x: icon.x + icon.width / 2, y: icon.y + icon.height / 2,
        width: icon.width, height: icon.height, buttonHeight: button.getBoundingClientRect().height }
    })
  })
  const expanded = await measure()
  for (const icon of expanded) {
    expect(icon.width).toBe(20)
    expect(icon.height).toBe(20)
    expect(icon.buttonHeight).toBe(40)
    expect(icon.x).toBe(26)
  }
  const tabButton = await page.getByTestId('new-tab-button').boundingBox()
  expect(tabButton).not.toBeNull()
  expect(Math.abs(expanded[0].y - (tabButton!.y + tabButton!.height / 2))).toBeLessThanOrEqual(1)
  const selectionGap = await sidebar.getByRole('button', { name: 'Assistant', exact: true }).evaluate(button => {
    const style = getComputedStyle(button)
    const header = button.closest('nav')!.previousElementSibling!.getBoundingClientRect()
    return { clip: style.backgroundClip, gap: button.getBoundingClientRect().top + parseFloat(style.borderTopWidth) - header.bottom }
  })
  expect(selectionGap).toEqual({ clip: 'padding-box', gap: 4 })
  await page.screenshot({ path: testInfo.outputPath('expanded-aligned.png') })
  await collapseSidebar(page)
  expect(await measure()).toEqual(expanded)
  await page.screenshot({ path: testInfo.outputPath('collapsed-aligned.png') })
  await expandButton(page).click()
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(224)
  expect(await measure()).toEqual(expanded)
})

test('sidebar tooltips wait for hover and reset when the sidebar changes mode', async ({ page }) => {
  const sidebar = page.getByTestId('left-sidebar')
  await sidebar.getByRole('button', { name: 'Assistant', exact: true }).focus()
  await collapseSidebar(page)
  await expect(page.getByRole('tooltip')).toHaveCount(0)

  const assistant = sidebar.getByRole('button', { name: 'Assistant', exact: true })
  await assistant.hover()
  await page.waitForTimeout(200)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await expect(page.getByRole('tooltip')).toHaveText('Assistant')

  await sidebar.getByRole('button', { name: 'Board', exact: true }).hover()
  await sidebar.getByRole('button', { name: 'Channels', exact: true }).hover()
  await page.mouse.move(800, 300)
  await page.waitForTimeout(700)
  await expect(page.getByRole('tooltip')).toHaveCount(0)

  await assistant.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Assistant')
  await expandButton(page).click()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await collapseSidebar(page)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
})

test('restoring window focus does not reopen a sidebar tooltip', async ({ page }) => {
  await collapseSidebar(page)
  const sidebar = page.getByTestId('left-sidebar')
  await sidebar.getByRole('button', { name: 'Assistant', exact: true }).click()
  await page.keyboard.press('Tab')
  await expect(sidebar.getByRole('button', { name: 'Board', exact: true })).toBeFocused()
  await expect(page.getByRole('tooltip')).toHaveText('Board')

  const board = sidebar.getByRole('button', { name: 'Board', exact: true })
  // Match the focus events delivered when macOS deactivates/reactivates a window.
  await board.evaluate(element => {
    element.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    element.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: null }))
  })
  await page.waitForTimeout(700)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.keyboard.press('Tab')
  await expect(page.getByRole('tooltip')).toHaveText('Channels')
})

test('sidebar labels and tooltips follow live language changes', async ({ page }) => {
  await page.getByTestId('settings-button').click()
  await page.getByTestId('settings-tab-appearance').click()
  await page.getByTestId('settings-appearance-locale-zh-CN').click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await page.getByTestId('settings-back-button').click()
  const sidebar = page.getByTestId('left-sidebar')
  for (const label of ['助理', '看板', '频道', '工作流', '插件', '定时任务', '设置']) {
    await expect(sidebar.getByRole('button', { name: label, exact: true })).toHaveText(label)
  }
  const help = sidebar.getByRole('button', { name: '帮助', exact: true })
  const settingsBox = await sidebar.getByTestId('settings-button').boundingBox()
  const helpBox = await help.boundingBox()
  expect(helpBox).not.toBeNull()
  expect(helpBox!.width).toBe(36)
  const helpIcon = await help.locator('svg').boundingBox()
  expect(helpIcon!.width).toBe(16)
  expect(helpIcon!.height).toBe(16)
  expect(helpBox!.y + helpBox!.height / 2).toBe(settingsBox!.y + settingsBox!.height / 2)
  await expect(page.getByTestId('toggle-sidebar')).toHaveAttribute('aria-label', '收起侧栏')
  await page.getByTestId('toggle-sidebar').click()
  await expect(page.getByTestId('toggle-sidebar')).toHaveAttribute('aria-label', '展开侧栏')
  await expect(sidebar.getByRole('button', { name: '帮助', exact: true })).toHaveCount(0)
  await sidebar.getByRole('button', { name: '项目', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '项目', exact: true })).toBeVisible()
  await expect(page.getByTestId('project-tree').getByRole('button', { name: '添加仓库', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await sidebar.getByRole('button', { name: '助理', exact: true }).hover()
  await expect(page.getByRole('tooltip')).toHaveText('助理')
  await page.getByTestId('toggle-sidebar').click()
  await page.getByTestId('settings-button').click()
  await page.getByTestId('settings-tab-appearance').click()
  await page.getByTestId('settings-appearance-locale-en').click()
  await page.getByTestId('settings-back-button').click()
  for (const label of ['Assistant', 'Board', 'Channels', 'Workflow', 'Plugins', 'Schedule', 'Settings']) {
    await expect(sidebar.getByRole('button', { name: label, exact: true })).toHaveText(label)
  }
  await expect(sidebar.getByRole('button', { name: 'Help', exact: true })).toBeVisible()
  await expect(page.getByTestId('toggle-sidebar')).toHaveAttribute('aria-label', 'Collapse sidebar')
})

test('collapsed sidebar keeps all navigation destinations directly accessible', async ({ page }) => {
  await collapseSidebar(page)
  const sidebar = page.getByTestId('left-sidebar')
  for (const name of ['Assistant', 'Board', 'Channels', 'Active', 'Projects', 'Workflow', 'Plugins', 'Schedule', 'Settings']) {
    const button = sidebar.getByRole('button', { name, exact: true })
    await expect(button).toBeVisible()
    await expect(button).toHaveText('')
  }
  await sidebar.getByRole('button', { name: 'Assistant', exact: true }).click()
  await expect(sidebar.getByRole('button', { name: 'Assistant', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(expandButton(page)).toBeVisible()
  // The inbox is reached through the Active list's header.
  await sidebar.getByRole('button', { name: 'Active', exact: true }).click()
  await page.getByTestId('active-flyout').getByRole('button', { name: 'Inbox', exact: true }).click()
  await expect(page.getByTestId('active-flyout')).toBeHidden()
  await expect(page.locator('.drag-region > span:visible').filter({ hasText: /^Inbox$/ })).toBeVisible()
  await expandButton(page).click()
  await expect(sidebar.getByRole('button', { name: 'Workflow', exact: true })).toHaveText('Workflow')
  await expect(page.getByTestId('project-tree')).toHaveAttribute('role', 'region')
})

test('project preview toggles and dismisses without resizing or changing the workspace', async ({ page }) => {
  await expect(page.getByTestId('project-tree').getByRole('button', { name: 'main', exact: true })).toBeVisible()
  const workspace = await page.evaluate(() => window.__operon?.workspace?.())
  await collapseSidebar(page)
  const trigger = page.getByRole('button', { name: 'Projects', exact: true })
  const tree = page.getByRole('dialog', { name: 'Projects', exact: true })
  const contentX = () => page.getByTestId('left-sidebar').evaluate(element => element.nextElementSibling?.getBoundingClientRect().x)
  const before = await contentX()
  await trigger.click()
  await expect(tree).toBeVisible()
  expect(await contentX()).toBe(before)
  await tree.getByRole('button', { name: 'Collapse Test Project', exact: true }).click()
  await expect(tree).toBeVisible()
  await expect(tree.getByRole('button', { name: 'main', exact: true })).toBeHidden()
  await tree.getByRole('button', { name: 'Expand Test Project', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(tree).toBeHidden()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await trigger.click()
  await expect(tree).toBeHidden()
  await trigger.click()
  await page.mouse.click(800, 300)
  await expect(tree).toBeHidden()
  expect(await page.evaluate(() => window.__operon?.workspace?.())).toEqual(workspace)
})

test('resting on the rail projects button floats the tree until the pointer leaves it', async ({ page }) => {
  await collapseSidebar(page)
  const trigger = page.getByRole('button', { name: 'Projects', exact: true })
  const tree = page.getByRole('dialog', { name: 'Projects', exact: true })

  // Passing over it is not enough.
  await trigger.hover()
  await page.mouse.move(800, 300)
  await page.waitForTimeout(700)
  await expect(tree).toBeHidden()

  await trigger.hover()
  await expect(tree).toBeVisible()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  // Reaching the panel crosses the gap beside the rail without closing it.
  await tree.getByRole('button', { name: 'main', exact: true }).hover()
  await page.waitForTimeout(500)
  await expect(tree).toBeVisible()
  await expect(tree).not.toBeFocused()
  await page.mouse.move(800, 300)
  await expect(tree).toBeHidden()

  // A click pins it, so leaving no longer closes it.
  await trigger.hover()
  await expect(tree).toBeVisible()
  await trigger.click()
  await page.mouse.move(800, 300)
  await page.waitForTimeout(500)
  await expect(tree).toBeVisible()
  await trigger.click()
  await expect(tree).toBeHidden()
})

test('resting on the rail active button floats the list until the pointer leaves it', async ({ page }) => {
  await collapseSidebar(page)
  const trigger = page.getByTestId('left-sidebar').getByRole('button', { name: 'Active', exact: true })
  const flyout = page.getByTestId('active-flyout')

  await trigger.hover()
  await expect(flyout).toBeVisible()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  // Reaching the panel crosses the gap beside the rail without closing it.
  await flyout.getByRole('button', { name: 'Inbox', exact: true }).hover()
  await page.waitForTimeout(500)
  await expect(flyout).toBeVisible()
  await page.mouse.move(800, 300)
  await expect(flyout).toBeHidden()

  // A click pins it, so leaving no longer closes it; a second click does.
  await trigger.hover()
  await expect(flyout).toBeVisible()
  await trigger.click()
  await page.mouse.move(800, 300)
  await page.waitForTimeout(500)
  await expect(flyout).toBeVisible()
  await trigger.click()
  await expect(flyout).toBeHidden()
})

test('closing the project preview hides its add button on the next frame', async ({ page }) => {
  await collapseSidebar(page)
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  const addButton = page.getByTestId('project-tree').locator('button[aria-label="Add repository"]')
  await expect(addButton).toBeVisible()
  await addButton.hover()
  await page.keyboard.press('Escape')
  const stillVisible = await addButton.evaluate(element => new Promise<boolean>(resolve => {
    requestAnimationFrame(() => resolve(element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })))
  }))
  expect(stillVisible).toBe(false)
})

test('selecting a workspace from the preview switches it and closes only the preview', async ({ page }) => {
  const project = await seededProject(page)
  const response = await page.request.post(`${apiUrl}/projects/${project.id}/workspaces`, {
    data: { name: 'feature/sidebar', branchName: 'feature/sidebar', worktreePath: project.rootPath },
  })
  expect(response.ok()).toBe(true)
  const { workspace } = await response.json() as { workspace: Workspace }
  await page.reload()
  await collapseSidebar(page)
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('dialog', { name: 'Projects' }).getByRole('button', { name: 'feature/sidebar', exact: true }).click()
  await expect(page.getByTestId('project-tree')).toBeHidden()
  await expect.poll(() => page.evaluate(() => window.__operon?.workspace?.()?.workspaceId)).toBe(workspace.id)
  await expect.poll(async () => (await page.getByTestId('left-sidebar').boundingBox())?.width).toBe(52)
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await expect(page.getByTestId('project-tree').getByRole('button', { name: 'feature/sidebar', exact: true })).toHaveAttribute('aria-current', 'page')
})

test('project tree keeps its node, scroll and folder state when the preview becomes fixed', async ({ page }, testInfo) => {
  const project = await seededProject(page)
  const projects: Project[] = [project, ...Array.from({ length: 35 }, (_, index) => ({
    ...project, id: index + 100, name: `Example project ${index + 1}`, specs: [], workspaces: [],
  }))]
  await page.route('**/api/projects?include=workspaces', route => route.fulfill({ json: { projects } }))
  await page.reload()
  const tree = page.getByTestId('project-tree')
  await tree.getByRole('button', { name: 'Collapse Test Project', exact: true }).click()
  const viewport = tree.locator('[data-slot="scroll-area-viewport"]')
  await viewport.evaluate(element => {
    element.scrollTop = 140
    element.setAttribute('data-preserved-node', 'yes')
  })
  await collapseSidebar(page)
  await page.screenshot({ path: testInfo.outputPath('collapsed.png') })
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await expect(viewport).toHaveAttribute('data-preserved-node', 'yes')
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(140)
  await page.screenshot({ path: testInfo.outputPath('preview.png') })
  await expandButton(page).click()
  await expect(tree).toHaveAttribute('role', 'region')
  await expect.poll(async () => (await page.getByTestId('left-sidebar').boundingBox())?.width).toBe(224)
  await expect(viewport).toHaveAttribute('data-preserved-node', 'yes')
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(140)
  await viewport.evaluate(element => { element.scrollTop = 0 })
  await expect(tree.getByRole('button', { name: 'Expand Test Project', exact: true })).toBeVisible()
  await expect(tree.getByRole('button', { name: 'main', exact: true })).toBeHidden()
  await page.screenshot({ path: testInfo.outputPath('expanded.png') })
  await collapseSidebar(page)
  await expect(tree).toBeHidden()
})

test('selecting a Spec closes the preview and retains its selected state', async ({ page }) => {
  const project = await seededProject(page)
  const created = await page.request.post(`${apiUrl}/tasks`, { data: { projectId: project.id, title: 'Sidebar spec' } })
  const { task } = await created.json() as { task: { id: number } }
  const response = await page.request.post(`${apiUrl}/test/spec-run`, { data: { taskId: task.id, stage: 'stopped' } })
  expect(response.ok()).toBe(true)
  await page.reload()
  await expect(page.getByTestId(`sidebar-spec-${task.id}`)).toBeVisible()
  await collapseSidebar(page)
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByTestId(`sidebar-spec-${task.id}`).click()
  await expect(page.getByTestId('project-tree')).toBeHidden()
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await expect(page.getByTestId(`sidebar-spec-${task.id}`)).toHaveAttribute('aria-current', 'page')
})


test('project preview coexists with the new workspace dialog', async ({ page }) => {
  await collapseSidebar(page)
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  const tree = page.getByTestId('project-tree')
  await tree.getByRole('button', { name: 'Collapse Test Project', exact: true }).hover()
  await tree.getByRole('button', { name: 'New workspace in Test Project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New Workspace', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Branch Name', exact: true }).fill('feature/test')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(tree).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tree).toBeHidden()
})

test('sidebar can expand while the right panel occupies the center', async ({ page }) => {
  await collapseSidebar(page)
  await page.getByTestId('toggle-right-panel').first().click()
  await page.getByRole('button', { name: 'Expand right panel', exact: true }).click()
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Projects', exact: true })).toBeVisible()
  await expandButton(page).click()
  await expect(page.getByTestId('project-tree')).toHaveAttribute('role', 'region')
  await expect.poll(async () => (await page.getByTestId('left-sidebar').boundingBox())?.width).toBe(224)
})

test('project preview fits the minimum desktop window in light and dark modes', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 960, height: 600 })
  await collapseSidebar(page)
  await page.getByTestId('left-sidebar').getByRole('button', { name: 'Assistant', exact: true }).click()
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(page.locator('html')).toHaveClass(new RegExp(colorScheme))
    await page.getByRole('button', { name: 'Projects', exact: true }).click()
    const tree = page.getByRole('dialog', { name: 'Projects', exact: true })
    await expect(tree.getByRole('button', { name: 'main', exact: true })).toBeVisible()
    const rect = await tree.boundingBox()
    expect(rect).not.toBeNull()
    expect(rect!.x).toBeGreaterThanOrEqual(52)
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(960)
    expect(rect!.y - 40).toBe(8)
    expect(600 - rect!.y - rect!.height).toBe(8)
    await page.screenshot({ path: testInfo.outputPath(`${colorScheme}.png`) })
    await page.keyboard.press('Escape')
  }
})
