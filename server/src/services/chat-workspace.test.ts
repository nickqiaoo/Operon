import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../types/project.js'
import { createChatWorkspace, type ChatWorkspaceStorage } from './chat-workspace.js'

const provision = vi.hoisted(() => vi.fn())
vi.mock('./workspace-provision.js', () => ({ provisionWorkspace: provision }))

const workspace = (id: number, projectId: number): Workspace =>
  ({ id, projectId, name: 'main', branchName: 'main', worktreePath: '/src/app', createdAt: 0, updatedAt: 0 })

const storage = {
  getChatMeta: (chatId: number) => (chatId === 42 ? { workspaceId: 6 } : chatId === 43 ? {} : undefined),
  getWorkspace: (id: number) => (id === 6 ? workspace(6, 5) : null),
  getProject: () => null,
  createWorkspace: () => workspace(0, 0),
} as unknown as ChatWorkspaceStorage

describe('createChatWorkspace', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("creates it in the conversation's project and reports where it is", async () => {
    provision.mockResolvedValue({ ...workspace(90, 5), name: 'login', branchName: 'login', worktreePath: '/wt/5-app/login' })
    expect(await createChatWorkspace(storage, 42, { name: 'login', base: 'develop' })).toEqual({
      workspace_id: 90, name: 'login', branch: 'login', worktree_path: '/wt/5-app/login', base_branch: 'develop',
    })
    expect(provision).toHaveBeenCalledWith(storage, { projectId: 5, name: 'login', base: 'develop' })
  })

  it('refuses outside a project workspace', async () => {
    await expect(createChatWorkspace(storage, 43, { name: 'x' })).rejects.toThrow('not in a project workspace')
    await expect(createChatWorkspace(storage, 404, { name: 'x' })).rejects.toThrow('not in a project workspace')
    expect(provision).not.toHaveBeenCalled()
  })
})
