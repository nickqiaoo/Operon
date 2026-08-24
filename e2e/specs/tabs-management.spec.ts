import { test, expect, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat, tabs } from '../helpers'

test.beforeEach(async () => {
  await resetServerState()
})

test('multiple chat tabs can be opened and switched between', async ({ page }) => {
  await setFakeScript('echo')

  await chat.openNewChat(page)
  await chat.openNewChat(page)

  const tabList = await tabs.list(page)
  expect(tabList.length).toBeGreaterThanOrEqual(2)

  // The most recently opened tab is active.
  const activeId = await page.evaluate(() => window.__operon?.activeTabId() ?? '')
  const last = tabList[tabList.length - 1]
  expect(last?.id).toBe(activeId)

  // Switching back to the first tab updates active id.
  await tabs.switchTo(page, 0)
  const firstActive = await page.evaluate(() => window.__operon?.activeTabId() ?? '')
  expect(firstActive).toBe(tabList[0]?.id)
})

test('tabs can be closed via the close button', async ({ page }) => {
  await setFakeScript('echo')
  await chat.openNewChat(page)
  await chat.openNewChat(page)

  const before = (await tabs.list(page)).length
  await tabs.close(page, before - 1)

  const after = (await tabs.list(page)).length
  expect(after).toBe(before - 1)
})
