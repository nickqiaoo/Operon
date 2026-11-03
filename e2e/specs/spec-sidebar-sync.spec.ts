import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { Project } from '../../src/stores/project-store'
import { test, expect, fakeOnly } from '../ci-fixtures'

const apiUrl = `http://127.0.0.1:${process.env.PW_CI_SERVER_PORT ?? 4100}/api`

/** Move the task's Spec run to `stage`; the test server announces it on the task feed. */
async function setSpecStage(page: Page, taskId: number, stage: string) {
  const response = await page.request.post(`${apiUrl}/test/spec-run`, { data: { taskId, stage } })
  expect(response.ok()).toBe(true)
}

test('Spec appears and updates in project navigation without opening the Board', async ({ page }) => {
  fakeOnly()
  // Other tasks may edit the shared checkout while this scenario runs.
  await page.routeWebSocket(/ws:\/\/127\.0\.0\.1:4101\//, (socket) => socket.close())
  await page.route('**/src/components/project/ProjectSidebar.tsx*', async (route) => {
    const response = await route.fetch()
    const body = await response.text()
    const marker = 'const pinned = project.pinnedAt != null;'
    expect(body).toContain(marker)
    // Count actual component calls, rather than relying on unchanged DOM nodes.
    await route.fulfill({ response, body: body.replace(marker, `
      window.__sidebarProjectRenders ??= {};
      window.__sidebarProjectRenders[project.id] = (window.__sidebarProjectRenders[project.id] ?? 0) + 1;
      window.__sidebarProjectRenderTime ??= {};
      window.__sidebarProjectRenderTime[project.id] = performance.now();
      ${marker}
    `) })
  })
  // Counted, not intercepted: the server answers both.
  let treeReads = 0
  let streamReads = 0
  page.on('request', (request) => {
    const url = request.url()
    if (url.endsWith('/api/projects?include=workspaces')) treeReads++
    if (url.includes('/api/events?') && url.includes('tasks')) streamReads++
  })

  const { projects } = await (await page.request.get(`${apiUrl}/projects?include=workspaces`)).json() as { projects: Project[] }
  const projectId = projects[0].id
  const unrelated = await (await page.request.post(`${apiUrl}/projects`, {
    data: { name: 'Unrelated project', rootPath: mkdtempSync(join(tmpdir(), 'operon-e2e-unrelated-')) },
  })).json() as { project: Project }
  // A task with no Spec run yet: not in the project's specs until one starts.
  const { task } = await (await page.request.post(`${apiUrl}/tasks`, {
    data: { projectId, title: 'Reading time' },
  })).json() as { task: { id: number } }

  await page.reload()
  const unrelatedRenders = () => page.evaluate((id) =>
    (window as unknown as { __sidebarProjectRenders?: Record<string, number> }).__sidebarProjectRenders?.[id] ?? 0, unrelated.project.id)
  await expect.poll(unrelatedRenders).toBeGreaterThan(0)
  // Let the initial diff-stat request settle before measuring task updates.
  await page.waitForFunction((id) => performance.now() -
    (window as unknown as { __sidebarProjectRenderTime: Record<string, number> }).__sidebarProjectRenderTime[id] > 750, unrelated.project.id)
  const rendersBeforeSpec = await unrelatedRenders()
  const selectedWorkspace = await page.evaluate(() => window.__operon?.workspace?.())

  const row = page.getByTestId(`sidebar-spec-${task.id}`)
  await expect(row).toHaveCount(0)
  await setSpecStage(page, task.id, 'grounding')
  await expect(row).toBeVisible()
  await expect(row).toContainText('Running')
  await setSpecStage(page, task.id, 'stopped')
  await expect(row).toContainText('Stopped')
  // A stage change re-reads the tree (that is where the row comes from), but the
  // unrelated project's row is not rendered again.
  expect(await unrelatedRenders()).toBe(rendersBeforeSpec)
  expect(await page.evaluate(() => window.__operon?.workspace?.())).toEqual(selectedWorkspace)

  // A dropped connection comes back with the server's full task snapshot. Nothing
  // in it changed, so project navigation is left alone.
  const readsBeforeDrop = treeReads
  const streamsBeforeDrop = streamReads
  // (Offline emulation leaves an established stream open, so the server ends it.)
  const dropped = await (await page.request.post(`${apiUrl}/test/events/drop`)).json() as { ended: number }
  expect(dropped.ended).toBeGreaterThan(0)
  await expect.poll(() => streamReads).toBeGreaterThan(streamsBeforeDrop)
  await expect(row).toContainText('Stopped')
  // The snapshot is applied 100ms after it lands (useTaskStream); give a refresh
  // that should not happen the time to show up.
  await page.waitForTimeout(500)
  expect(treeReads).toBe(readsBeforeDrop)
  expect(await unrelatedRenders()).toBe(rendersBeforeSpec)

  const archived = await page.request.post(`${apiUrl}/tasks/${task.id}/archive`, { data: { archived: true } })
  expect(archived.ok()).toBe(true)
  await expect(row).toHaveCount(0)
})
