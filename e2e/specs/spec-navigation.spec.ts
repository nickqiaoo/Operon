import type { Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { SpecChatRef, SpecView } from '../../shared/spec'
import type { Project, Workspace, WorkspaceTask } from '../../src/stores/project-store'
import type { TaskDetail } from '../../src/types/task'
import { test, expect, fakeOnly } from '../ci-fixtures'

const apiUrl = `http://127.0.0.1:${process.env.PW_CI_SERVER_PORT ?? 4100}/api`

async function installSpec(page: Page, completed = false, withCoordinator = false) {
  const response = await page.request.get(`${apiUrl}/projects?include=workspaces`)
  const { projects } = await response.json() as { projects: Project[] }
  const project = projects[0]
  const main = project.workspaces[0]
  const makeWorkspace = async (name: string): Promise<Workspace> => {
    const worktreePath = `${main.worktreePath}/${name}`
    mkdirSync(worktreePath, { recursive: true })
    writeFileSync(`${worktreePath}/README.md`, `# ${name} workspace`)
    const response = await page.request.post(`${apiUrl}/projects/${project.id}/workspaces`, { data: { name, branchName: name, worktreePath } })
    const { workspace } = await response.json() as { workspace: Workspace }
    return workspace
  }
  const specWorkspace = completed ? null : await makeWorkspace('spec-22')
  const implementerWorkspace = completed ? null : await makeWorkspace('ticket-24')
  const reviewerWorkspace = completed ? null : await makeWorkspace('review-24')
  const makeChat = async (title: string, subAgent: boolean, workspace: Workspace | null): Promise<SpecChatRef> => {
    const result = await page.request.post(`${apiUrl}/chat-history`, { data: {
      baseRevision: 0, replaceFrom: 0, providerId: 'fake', model: 'fake-1', workspaceId: workspace?.id ?? main.id,
      tp: subAgent ? 'subagent' : 'chat',
      tailMessages: [
        { id: `user-${title}`, role: 'user', parts: [{ type: 'text', text: title }] },
        { id: `assistant-${title}`, role: 'assistant', parts: [
          ...(!subAgent ? [{ type: 'dynamic-tool', toolName: 'start_spec', toolCallId: 'start-spec', state: 'output-available', input: { title: 'Post navigation' }, output: { content: [{ type: 'text', text: 'Created task #22: Post navigation' }], structuredContent: { kind: 'created-task', taskId: 100, taskNumber: 22, title: 'Post navigation', spec: true } } }] : []),
          { type: 'text', text: `${title} transcript` },
        ] },
        ...(!subAgent ? [{ id: 'spec-notice', role: 'user', parts: [{ type: 'text', text: '<spec-notice spec="22">Ready for review.</spec-notice>' }] }] : []),
      ],
    } })
    const { chatId } = await result.json() as { chatId: number }
    return { chatId, title, providerId: 'fake', subAgent, workspaceId: workspace?.id ?? null, cwd: workspace?.worktreePath ?? `${main.worktreePath}/removed-ticket`, updatedAt: Date.now() }
  }
  const sourceChat = await makeChat('Plan post navigation', false, main)
  const implementer = await makeChat('Implement adjacent navigation', true, implementerWorkspace)
  const reviewer = await makeChat('Review navigation links', true, reviewerWorkspace)
  const coordinator = withCoordinator ? await makeChat('Ticket #24 is blocked: investigate the failed review session', true, specWorkspace) : null
  const task: WorkspaceTask = { id: 100, number: 22, title: 'Post navigation', status: completed ? 'done' : 'in_progress', parentTaskId: null, specStage: completed ? 'done' : 'stopped' }
  const spec: SpecView = {
    taskId: task.id, taskNumber: task.number, title: task.title,
    run: {
      taskId: task.id, stage: completed ? 'done' : 'stopped',
      config: { lead: { providerId: 'fake' }, explorer: { providerId: 'fake' }, candidates: [{ providerId: 'fake' }], judge: { providerId: 'fake' }, builder: { providerId: 'fake' } },
      designSha: null, workflowRunId: 'run-1', runIds: ['run-1'], build: [], rulings: [], error: null, proposal: null, createdAt: Date.now(), updatedAt: Date.now(),
    },
    worktreePath: specWorkspace?.worktreePath ?? null, specDir: '.operon/changes/task-22',
    brief: 'Add previous and next post links.', grounding: null, candidates: [], judge: null, design: '# Navigation design\n\nKeep links in the same language.', synthesis: null,
    tickets: [{ key: 'T1', title: 'Implement post links', delivers: 'Readers can open adjacent posts.', acceptance: ['Links stay within the current language.'], blockedBy: [], interfaces: [] }],
    questions: null, feedback: null, review: null, reviewSummary: null, running: false,
    providers: ['fake'], availableProviders: ['fake'], seats: [], designChanged: false,
    ticketTasks: { T1: { id: 101, number: 24, status: 'done', workspaceId: completed ? null : implementer.workspaceId, chats: [implementer] } },
    agents: [
      { runId: 'run-1', index: 0, label: 'implement T1 · fake', phase: 'Build', agentType: 'fake', state: 'done', chats: [implementer] },
      { runId: 'run-1', index: 1, label: 'review T1 · fake', phase: 'Build', agentType: 'fake', state: 'done', chats: [reviewer] },
    ],
    sourceChat, elapsedMs: 1000, coordinator: coordinator ? { agentName: 'coordinator', providerId: 'fake', status: 'idle', chatId: coordinator.chatId, chat: coordinator, workspaceId: specWorkspace?.id ?? null } : null, integration: null,
  }
  const tree: Project = { ...project, specs: [task], workspaces: [main,
    ...(specWorkspace ? [{ ...specWorkspace, task }] : []),
    ...(implementerWorkspace ? [{ ...implementerWorkspace, task: { ...task, id: 101, number: 24, specStage: null, parentTaskId: 100 } }] : []),
    ...(reviewerWorkspace ? [{ ...reviewerWorkspace, task: { ...task, id: 102, number: 25, specStage: null, parentTaskId: 100 } }] : []),
  ] }
  await page.route('**/api/projects?include=workspaces', (route) => route.fulfill({ json: { projects: [tree] } }))
  await page.route('**/api/spec/100', (route) => route.fulfill({ json: { spec } }))
  // The scripted test provider has no CLI binary for the production availability probe.
  await page.route('**/api/ai/providers', async (route) => {
    const response = await route.fetch()
    const providers = await response.json() as Array<{ id: string; label: string; logo: string; available: boolean }>
    await route.fulfill({ json: providers.map((provider) => provider.id === 'fake' ? { ...provider, available: true } : provider) })
  })
  if (completed) {
    await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('operon-projects') ?? '{}') as { state?: Record<string, unknown> }
      localStorage.setItem('operon-projects', JSON.stringify({ ...saved, state: { ...saved.state, shownSpecIds: [100] } }))
    })
  }
  await page.reload()
  return { main, spec, tree, projectId: project.id, implementer, implementerWorkspace }
}

async function openMobileSpec(page: Page) {
  // Mount the production phone shell through the normal bootstrap, sharing
  // its React/Query context. The desktop test build has no broker login gate.
  await page.route('**/src/main.tsx*', async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    const body = source.replace(/import Root from "\/src\/Root\.tsx(?:\?[^\"]*)?";/, 'import { MobileApp as Root } from "/src/components/mobile/MobileApp.tsx";')
    expect(body).not.toBe(source)
    await route.fulfill({ response, body })
  })
  await page.setViewportSize({ width: 375, height: 812 })
  await page.reload()
  await page.locator('header').getByRole('button').first().click()
  await page.getByRole('button', { name: 'Post navigation', exact: true }).click()
  await expect(page.getByTestId('mobile-spec-page')).toBeVisible()
}

test('phone Spec sessions preserve discussion drafts and use scoped agent conversations', async ({ page }, testInfo) => {
  fakeOnly()
  const { main, implementer, implementerWorkspace, spec, tree } = await installSpec(page, false, true)
  await openMobileSpec(page)
  const screen = page.getByTestId('mobile-spec-page')
  await screen.getByRole('button', { name: 'Discussion', exact: true }).click()
  const input = screen.getByRole('textbox', { name: /Ask anything/ })
  await expect(input).toBeVisible()
  await input.fill('Keep the phone discussion draft')
  await screen.getByRole('button', { name: 'Back', exact: true }).click()
  await screen.getByRole('button', { name: 'Sessions', exact: true }).click()
  await expect(screen.getByRole('heading', { name: 'Build' })).toBeVisible()
  await screen.getByRole('button', { name: 'Coordinator', exact: true }).click()
  await expect(screen.getByRole('textbox', { name: /Ask anything/ })).toBeVisible()
  await screen.getByRole('button', { name: 'Coordinator Spec #22' }).click()
  await page.getByRole('button', { name: 'T1 · Implement post links', exact: true }).click()
  await expect(screen.getByText('Implement adjacent navigation transcript', { exact: true })).toBeVisible()
  await screen.getByRole('textbox', { name: /Ask anything/ }).fill('Continue the phone session')
  const sent = page.waitForRequest((request) => request.url().endsWith('/api/ai/chat') && request.method() === 'POST')
  await screen.getByRole('button', { name: 'Submit', exact: true }).click()
  expect((await sent).postDataJSON()).toMatchObject({ chatId: implementer.chatId, providerId: 'fake', tp: 'subagent', workspaceId: implementerWorkspace!.id })
  await expect(screen.getByRole('log').locator('[data-testid="message-assistant"]').last()).toContainText(/fake runtime/i)
  await screen.getByRole('button', { name: 'T1 · Implement post links Spec #22' }).click()
  await page.getByRole('button', { name: 'Discussion', exact: true }).click()
  await expect(input).toHaveValue('Keep the phone discussion draft')
  await page.screenshot({ path: testInfo.outputPath('mobile-spec-discussion.png') })
  await screen.getByRole('button', { name: 'Back', exact: true }).click()
  await screen.getByRole('button', { name: 'Sessions', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('mobile-spec-sessions.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await screen.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(screen).toHaveCount(0)
  await expect(page.locator('header')).toContainText('main')
  // Local-only payload for validating the same screen inside the native shell.
  writeFileSync('/tmp/xui-mobile-spec-fixture.json', JSON.stringify({ spec, tree, main }))
})

test('phone completed Spec keeps conversations available without execution worktrees', async ({ page }) => {
  fakeOnly()
  await installSpec(page, true)
  await openMobileSpec(page)
  const screen = page.getByTestId('mobile-spec-page')
  await screen.getByRole('button', { name: 'Changes', exact: true }).click()
  await expect(screen.getByText(/workspaces for this Spec have been removed/)).toBeVisible()
  await screen.getByRole('button', { name: 'Sessions', exact: true }).click()
  await screen.getByRole('button', { name: 'T1 · Implement post links', exact: true }).click()
  await expect(screen.getByRole('textbox', { name: /Ask anything/ })).toBeVisible()
})

test('Spec conversations share the original chat, files and terminal workbench', async ({ page }, testInfo) => {
  fakeOnly()
  const { main, spec, implementer, implementerWorkspace } = await installSpec(page)
  await page.getByRole('button', { name: 'Chat history', exact: true }).click()
  await page.getByRole('button', { name: /Plan post navigation/ }).click()
  const draft = page.getByRole('textbox', { name: /Ask anything/ })
  await draft.fill('Keep the original discussion draft')
  const originalTabId = await page.evaluate(() => window.__operon?.activeTabId())
  const mod = await page.evaluate(() => navigator.platform.toLowerCase().includes('mac') ? 'Meta' : 'Control')
  await page.keyboard.press(`${mod}+p`)
  await expect.poll(() => page.evaluate(() => window.__operon?.panels?.().right.tabs[0]?.type)).toBe('workspace-browser')
  const originalFilesId = await page.evaluate(() => window.__operon?.panels?.().right.tabs[0]?.tabId)

  await page.getByTestId('sidebar-spec-100').click()
  const task = page.getByTestId('spec-page')
  await expect(task).toBeVisible()
  await expect(page.getByTestId('sidebar-spec-100')).toHaveAttribute('aria-current', 'page')
  await expect(task.getByRole('button', { name: 'Chat history', exact: true })).toHaveCount(0)
  await task.getByRole('tab', { name: 'discussion', exact: true }).click()
  await expect(draft).toHaveValue('Keep the original discussion draft')
  expect(await page.evaluate(() => window.__operon?.activeTabId())).toBe(originalTabId)
  expect(await page.evaluate(() => window.__operon?.panels?.().right.tabs[0]?.tabId)).toBe(originalFilesId)
  expect(await page.evaluate(() => window.__operon?.panels?.().right.open)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('spec-discussion-workbench.png') })

  await task.getByRole('tab', { name: 'sessions', exact: false }).click()
  await expect(task.getByText('Implement adjacent navigation transcript', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__operon?.workspace()?.workspaceId)).toBe(implementerWorkspace!.id)
  await expect(task.getByRole('textbox', { name: /Ask anything/ })).toBeVisible()
  await task.getByRole('textbox', { name: /Ask anything/ }).fill('Continue implementing')
  const agentSent = page.waitForRequest((request) => request.url().endsWith('/api/ai/chat') && request.method() === 'POST')
  await task.getByRole('button', { name: 'Submit', exact: true }).click()
  expect((await agentSent).postDataJSON()).toMatchObject({ chatId: implementer.chatId, workspaceId: implementerWorkspace!.id, providerId: 'fake', tp: 'subagent' })
  await expect(task.getByRole('log').locator('[data-testid="message-assistant"]').last()).toContainText(/fake runtime/i)
  await page.keyboard.press(`${mod}+p`)
  await expect.poll(() => page.evaluate(() => window.__operon?.panels?.().right.tabs[0]?.type)).toBe('workspace-browser')
  expect(await page.evaluate(() => window.__operon?.panels?.().right.tabs[0]?.tabId)).toContain(implementerWorkspace!.worktreePath)
  await page.keyboard.press(`${mod}+j`)
  await expect.poll(() => page.evaluate(() => window.__operon?.panels?.().bottom.tabs[0]?.type)).toBe('terminal')
  await page.screenshot({ path: testInfo.outputPath('spec-session-workbench.png') })
  await page.keyboard.press(`${mod}+j`)

  await task.getByRole('combobox', { name: 'Spec session', exact: true }).selectOption({ label: 'Review navigation links' })
  await expect(task.getByText('Review navigation links transcript', { exact: true })).toBeVisible()
  await task.getByRole('tab', { name: 'discussion', exact: true }).click()
  await expect(draft).toHaveValue('Keep the original discussion draft')
  expect(await page.evaluate(() => window.__operon?.panels?.().right.tabs[0]?.tabId)).toBe(originalFilesId)
  expect(await page.evaluate(() => window.__operon?.panels?.().right.open)).toBe(true)
  await task.getByRole('textbox', { name: /Ask anything/ }).fill('Continue the discussion')
  const sent = page.waitForRequest((request) => request.url().endsWith('/api/ai/chat') && request.method() === 'POST')
  await task.getByRole('button', { name: 'Submit', exact: true }).click()
  expect((await sent).postDataJSON()).toMatchObject({ chatId: spec.sourceChat!.chatId, workspaceId: main.id, providerId: 'fake' })
  await expect(task.getByRole('log').locator('[data-testid="message-assistant"]').last()).toContainText(/fake runtime/i)
  await draft.fill('Draft after viewing the Spec')
  await page.getByRole('button', { name: 'main', exact: true }).click()
  await expect(draft).toHaveValue('Draft after viewing the Spec')
  expect(await page.evaluate(() => window.__operon?.activeTabId())).toBe(originalTabId)
  await page.getByTestId('sidebar-spec-100').click()
  await expect(task.getByRole('tab', { name: 'discussion', exact: true })).toHaveAttribute('data-state', 'active')
})

test('Board keeps its original task detail while the sidebar opens the dedicated Spec page', async ({ page }) => {
  fakeOnly()
  const { projectId } = await installSpec(page)
  const response = await page.request.post(`${apiUrl}/tasks`, { data: { projectId, title: 'Post navigation' } })
  const { task } = await response.json() as { task: TaskDetail }
  const detail: TaskDetail = { ...task, id: 100, number: 22, specStage: 'stopped' }
  await page.route(/\/api\/tasks(?:\?.*)?$/, (route) => route.fulfill({ json: { tasks: [detail] } }))
  await page.route('**/api/tasks/100', (route) => route.fulfill({ json: { task: detail } }))

  await page.getByRole('button', { name: 'Board', exact: true }).click()
  await page.locator('[aria-roledescription="draggable"]').filter({ hasText: 'Post navigation' }).click()
  await expect(page.getByRole('heading', { name: 'Post navigation', exact: true })).toBeVisible()
  await expect(page.getByText('Description', { exact: true })).toBeVisible()
  await expect(page.getByText('Activity', { exact: true })).toBeVisible()
  await expect(page.getByTestId('spec-page')).toHaveCount(0)

  await page.getByTestId('sidebar-spec-100').click()
  await expect(page.getByTestId('spec-page')).toBeVisible()
  await page.getByRole('button', { name: 'Board', exact: true }).click()
  await expect(page.getByTestId('spec-page')).toBeHidden()
  await expect(page.getByText('Description', { exact: true })).toBeVisible()
  await expect(page.getByText('Activity', { exact: true })).toBeVisible()
})

test('completed Spec logs remain accessible after all execution worktrees are removed', async ({ page }) => {
  fakeOnly()
  const { main, implementer } = await installSpec(page, true)
  await page.getByTestId('sidebar-spec-100').click()
  const task = page.getByTestId('spec-page')
  await task.getByRole('tab', { name: 'sessions', exact: false }).click()
  await expect(task.getByText('Implement adjacent navigation transcript', { exact: true })).toBeVisible()
  await expect(task.getByRole('textbox', { name: /Ask anything/ })).toBeVisible()
  await task.getByRole('textbox', { name: /Ask anything/ }).fill('Continue after integration')
  const sent = page.waitForRequest((request) => request.url().endsWith('/api/ai/chat') && request.method() === 'POST')
  await task.getByRole('button', { name: 'Submit', exact: true }).click()
  expect((await sent).postDataJSON()).toMatchObject({ chatId: implementer.chatId, workspaceId: main.id })
  await expect(task.getByRole('log').locator('[data-testid="message-assistant"]').last()).toContainText(/fake runtime/i)
  await task.getByRole('tab', { name: 'changes', exact: true }).click()
  await expect(task.getByText('The workspaces for this Spec have been removed. Sessions and review documents remain available.')).toBeVisible()
  await expect(task.getByRole('button', { name: 'Open workspace' })).toHaveCount(0)
})
