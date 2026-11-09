import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Workspace } from '../../src/stores/project-store'
import type { TaskDetail } from '../../src/types/task'
import { test, expect, fakeOnly, resetServerState } from '../ci-fixtures'

const apiUrl = `http://127.0.0.1:${process.env.PW_CI_SERVER_PORT ?? 4100}/api`
const CHAT_TITLE = 'Plan the divide helper'
const PROJECT_NAME = 'Divide Repo'

/** A conversation whose agent just created a task, the way a real transcript records it. */
async function installCreatedTask(page: Page) {
  // Dispatch cuts the task its own worktree, so it needs a repository with a commit. The seeded project is a plain folder.
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'operon-dispatch-'))
  writeFileSync(join(root, 'README.md'), '# Divide\n')
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], { cwd: root })
  git('init', '-b', 'main')
  git('add', '.')
  git('commit', '-m', 'init')
  const { project } = await (await page.request.post(`${apiUrl}/projects`, { data: { name: PROJECT_NAME, rootPath: root } })).json() as { project: Project }
  const { workspace: main } = await (await page.request.post(`${apiUrl}/projects/${project.id}/workspaces`, { data: { name: 'repo-main', branchName: 'main', worktreePath: root } })).json() as { workspace: Workspace }

  const { task } = await (await page.request.post(`${apiUrl}/tasks`, { data: { projectId: project.id, title: 'Add a divide helper' } })).json() as { task: TaskDetail }
  await page.request.post(`${apiUrl}/agents`, { data: { name: 'builder', provider: 'fake', model: 'fake-1', instructions: '' } })
  await page.request.post(`${apiUrl}/chat-history`, { data: {
    providerId: 'fake', model: 'fake-1', workspaceId: main.id, tp: 'chat', title: CHAT_TITLE,
    messages: [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Put the divide helper on the board' }] },
      { id: 'assistant-1', role: 'assistant', parts: [
        { type: 'dynamic-tool', toolName: 'mcp__taskboard__create_project_task', toolCallId: 'create-1', state: 'output-available',
          input: { title: task.title, description: 'Add divide()' },
          output: { content: [{ type: 'text', text: `Created task #${task.number} "${task.title}" (todo).` }],
            structuredContent: { kind: 'created-task', taskId: task.id, taskNumber: task.number, title: task.title } } },
        { type: 'text', text: 'It is on the board.' },
      ] },
    ],
  } })
  await page.reload()
  return task
}

/** A saved conversation opens from the tab bar's history menu. */
async function openChat(page: Page) {
  const workspace = page.getByText('repo-main').first()
  if (!(await workspace.isVisible())) await page.getByText(PROJECT_NAME).first().click()
  await workspace.click()
  await page.getByRole('button', { name: 'Chat history' }).click()
  await page.getByText(CHAT_TITLE).first().click()
}

const readTask = async (page: Page, id: number) =>
  ((await (await page.request.get(`${apiUrl}/tasks/${id}`)).json()) as { task: TaskDetail }).task

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

test('a task created in chat is dispatched from its card', async ({ page }, testInfo) => {
  const task = await installCreatedTask(page)
  await openChat(page)

  const dispatch = page.getByRole('button', { name: 'Dispatch', exact: true })
  await expect(dispatch).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('1-card.png') })

  await dispatch.click()
  const builder = page.getByRole('menuitem', { name: /@builder/ })
  await expect(builder).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('2-picker.png') })
  await builder.click()

  // The server, not just the card: assigned, moved on, and a worktree session started.
  await expect.poll(async () => (await readTask(page, task.id)).status).toBe('in_progress')
  const dispatched = await readTask(page, task.id)
  expect(dispatched.assignedAgent?.name).toBe('builder')
  expect(dispatched.bindingId).not.toBeNull()

  await expect(dispatch).toBeHidden()
  await expect(page.getByText(`#${task.number} · @builder`)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('3-dispatched.png') })

  // Dispatched is the task's state, so reopening the conversation doesn't bring the button back.
  await page.reload()
  await openChat(page)
  await expect(page.getByText(`#${task.number} · @builder`)).toBeVisible()
  await expect(dispatch).toBeHidden()
})
