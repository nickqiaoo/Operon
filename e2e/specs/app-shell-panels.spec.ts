import { test, expect, fakeOnly } from '../ci-fixtures'

/**
 * Codex-style app shell — right + bottom panels and their tab system.
 *
 * These exercise the renderer-only shell mechanics (panel open/close, the
 * empty-panel quick picks, the new-tab menu, opening/closing a tab) without
 * relying on the Electron-backed tab *content* (webview / pty / git), which is
 * inert under the test-renderer. Panel + tab state is read through the
 * `window.__operon.panels()` / `.project()` probe rather than scraping the DOM.
 *
 * Fake-mode only: real mode is the user's live workspace with its own open
 * panels/tabs, so the "starts empty" assumptions wouldn't hold.
 */

type Panels = ReturnType<NonNullable<NonNullable<Window['__operon']>['panels']>>

const panels = (page: import('@playwright/test').Page): Promise<Panels | null> =>
  page.evaluate(() => window.__operon?.panels?.() ?? null)

/** Cmd on macOS, Ctrl elsewhere — matches the app-shell keydown handler. */
async function primaryModifier(page: import('@playwright/test').Page): Promise<'Meta' | 'Control'> {
  const isMac = await page.evaluate(() => navigator.platform.toLowerCase().includes('mac'))
  return isMac ? 'Meta' : 'Control'
}

/** Wait until the seeded workspace has loaded into the project store. */
async function waitWorkspaceActive(page: import('@playwright/test').Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__operon?.project?.()?.activeWorkspaceId ?? null), {
      message: 'seeded workspace never became active',
      timeout: 10_000,
    })
    .not.toBeNull()
}

test.beforeEach(() => {
  // Panel emptiness + workspace gating are deterministic only against the fake
  // seed; real mode connects to the user's populated app.
  fakeOnly()
})

test('right panel opens and closes from the top-bar toggle', async ({ page }) => {
  expect((await panels(page))?.right.open).toBe(false)

  await page.getByTestId('toggle-right-panel').first().click()
  await expect.poll(async () => (await panels(page))?.right.open).toBe(true)

  // An empty panel surfaces the quick-pick cards instead of a blank pane.
  const rightPanel = page.locator('[data-app-shell-focus-area="right-panel"]')
  await expect(rightPanel.getByTestId('empty-panel-card-browser')).toBeVisible()

  await page.getByTestId('toggle-right-panel').first().click()
  await expect.poll(async () => (await panels(page))?.right.open).toBe(false)
})

test('bottom panel toggles with the keyboard shortcut', async ({ page }) => {
  const mod = await primaryModifier(page)

  expect((await panels(page))?.bottom.open).toBe(false)

  await page.keyboard.press(`${mod}+j`)
  await expect.poll(async () => (await panels(page))?.bottom.open).toBe(true)

  const bottomPanel = page.locator('[data-app-shell-focus-area="bottom-panel"]')
  await expect(bottomPanel.getByTestId('empty-panel-card-terminal')).toBeVisible()

  await page.keyboard.press(`${mod}+j`)
  await expect.poll(async () => (await panels(page))?.bottom.open).toBe(false)
})

test('right panel toggles with the keyboard shortcut', async ({ page }) => {
  const mod = await primaryModifier(page)

  expect((await panels(page))?.right.open).toBe(false)

  await page.keyboard.press(`${mod}+\\`)
  await expect.poll(async () => (await panels(page))?.right.open).toBe(true)

  await page.keyboard.press(`${mod}+\\`)
  await expect.poll(async () => (await panels(page))?.right.open).toBe(false)
})

test('empty right panel surfaces the four new-tab quick picks', async ({ page }) => {
  await waitWorkspaceActive(page)

  await page.getByTestId('toggle-right-panel').first().click()
  await expect.poll(async () => (await panels(page))?.right.open).toBe(true)

  const rightPanel = page.locator('[data-app-shell-focus-area="right-panel"]')
  for (const type of ['workspace-browser', 'review', 'browser', 'terminal']) {
    await expect(rightPanel.getByTestId(`empty-panel-card-${type}`)).toBeVisible()
  }

  // Browser + Terminal never require a workspace.
  await expect(rightPanel.getByTestId('empty-panel-card-browser')).toBeEnabled()
  await expect(rightPanel.getByTestId('empty-panel-card-terminal')).toBeEnabled()
  // With the seeded workspace active, the workspace-gated picks are enabled too.
  await expect(rightPanel.getByTestId('empty-panel-card-workspace-browser')).toBeEnabled()
  await expect(rightPanel.getByTestId('empty-panel-card-review')).toBeEnabled()
})

test('the new-tab menu lists the available tab kinds', async ({ page }) => {
  await page.getByTestId('toggle-right-panel').first().click()
  await expect.poll(async () => (await panels(page))?.right.open).toBe(true)

  await page.getByTestId('new-tab-trigger-right').click()

  // Dropdown items render in a portal; both workspace-free kinds are present.
  await expect(page.getByTestId('new-tab-item-browser')).toBeVisible()
  await expect(page.getByTestId('new-tab-item-terminal')).toBeVisible()
})

test('opening a browser tab from the empty state adds it to the right panel', async ({ page }) => {
  await page.getByTestId('toggle-right-panel').first().click()
  await expect.poll(async () => (await panels(page))?.right.open).toBe(true)

  const rightPanel = page.locator('[data-app-shell-focus-area="right-panel"]')
  // Browser is the workspace-free pick, so it works without a seeded repo.
  await rightPanel.getByTestId('empty-panel-card-browser').click()

  // The tab lands in the right panel's stack with the right payload type, and
  // the empty-state cards give way to a real tab-bar item.
  await expect.poll(async () => (await panels(page))?.right.tabs.length).toBe(1)
  const opened = await panels(page)
  expect(opened?.right.tabs[0]?.type).toBe('browser')
  await expect(rightPanel.getByTestId('panel-tab').first()).toBeVisible()
  // The empty-state quick picks unmount once the panel holds a tab.
  await expect(rightPanel.getByTestId('empty-panel-card-browser')).toHaveCount(0)
})
