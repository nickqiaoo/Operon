import type { Project, WorkspaceTask } from '../../src/stores/project-store'
import { test, expect, fakeOnly } from '../ci-fixtures'

test('Spec appears and updates in project navigation without opening the Board', async ({ page }) => {
  fakeOnly()
  let spec: WorkspaceTask | null = null
  let projectId = 0
  let treeReads = 0
  let streamReads = 0
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
  await page.route('**/api/projects?include=workspaces', async (route) => {
    treeReads++
    const response = await route.fetch()
    const { projects } = await response.json() as { projects: Project[] }
    projectId = projects[0].id
    await route.fulfill({ json: { projects: [...projects.map((project, index) => index === 0
      ? { ...project, specs: spec ? [spec] : [] }
      : project), { ...projects[0], id: 9000, name: 'Unrelated project', workspaces: [], specs: [] }] } })
  })
  await page.route('**/api/tasks/stream*', async (route) => {
    streamReads++
    // The production SSE reader reconnects after this finite stream. Each new
    // connection receives the latest snapshot, just like the server endpoint.
    const data = spec ? `data: ${JSON.stringify({ type: 'task_upsert', task: { ...spec, projectId, workspaceId: null } })}\n\n` : ': ready\n\n'
    await route.fulfill({ contentType: 'text/event-stream', body: data })
  })
  await page.reload()
  await expect.poll(() => projectId).toBeGreaterThan(0)
  const unrelatedRenders = () => page.evaluate(() =>
    (window as unknown as { __sidebarProjectRenders: Record<string, number> }).__sidebarProjectRenders?.[9000] ?? 0)
  await expect.poll(unrelatedRenders).toBeGreaterThan(0)
  // Let the initial diff-stat request settle before measuring task updates.
  await page.waitForFunction(() => performance.now() -
    (window as unknown as { __sidebarProjectRenderTime: Record<string, number> }).__sidebarProjectRenderTime[9000] > 750)
  const rendersBeforeSpec = await unrelatedRenders()
  const selectedWorkspace = await page.evaluate(() => window.__operon?.workspace?.())
  spec = { id: 2500, number: 25, title: 'Reading time', status: 'in_progress', parentTaskId: null, specStage: 'grounding', archivedAt: null }
  const row = page.getByTestId('sidebar-spec-2500')
  await expect(row).toBeVisible()
  await expect(row).toContainText('Running')
  spec = { ...spec, specStage: 'stopped' }
  await expect(row).toContainText('Stopped')
  expect(await unrelatedRenders()).toBe(rendersBeforeSpec)
  expect(await page.evaluate(() => window.__operon?.workspace?.())).toEqual(selectedWorkspace)

  // Repeated reconnect snapshots must leave project navigation alone.
  const readsAfterStop = treeReads
  const streamsAfterStop = streamReads
  await expect.poll(() => streamReads).toBeGreaterThan(streamsAfterStop)
  expect(treeReads).toBe(readsAfterStop)
  expect(await unrelatedRenders()).toBe(rendersBeforeSpec)
  spec = { ...spec, archivedAt: Date.now() }
  await expect(row).toHaveCount(0)
})
