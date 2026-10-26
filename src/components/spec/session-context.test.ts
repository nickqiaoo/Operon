import { describe, expect, it } from 'vitest'
import type { Project } from '@/stores/project-store'
import type { SpecChatRef } from '@shared/spec'
import { specSessionWorkspace } from './session-context'

const project: Project = {
  id: 1, name: 'Blog', rootPath: '/blog', createdAt: 0, updatedAt: 0,
  workspaces: [
    { id: 1, name: 'main', branchName: 'main', worktreePath: '/blog' },
    { id: 2, name: 'source', branchName: 'source', worktreePath: '/source' },
    { id: 3, name: 'ticket', branchName: 'ticket', worktreePath: '/ticket' },
  ],
}
const chat = (workspaceId: number | null, cwd: string | null = null): SpecChatRef => ({
  chatId: 10, title: 'Session', providerId: 'codex', subAgent: true, updatedAt: 0, workspaceId, cwd,
})

describe('Spec session workspaces', () => {
  it('opens a conversation in its own workspace, by id or by directory', () => {
    expect(specSessionWorkspace(project, chat(3))?.id).toBe(3)
    expect(specSessionWorkspace(project, chat(null, '/ticket'))?.id).toBe(3)
  })
  it('has no workspace once that one is removed, rather than borrowing another', () => {
    expect(specSessionWorkspace(project, chat(99, '/removed'))).toBeNull()
    expect(specSessionWorkspace(project, chat(null))).toBeNull()
    expect(specSessionWorkspace(project, null)).toBeNull()
  })
})
