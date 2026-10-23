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
  it('uses the conversation workspace before any source or project fallback', () => {
    expect(specSessionWorkspace(project, chat(3), chat(2))?.id).toBe(3)
    expect(specSessionWorkspace(project, chat(null, '/ticket'), chat(2))?.id).toBe(3)
  })
  it('continues a reclaimed session in the source workspace or project checkout', () => {
    expect(specSessionWorkspace(project, chat(99, '/removed'), chat(2))?.id).toBe(2)
    expect(specSessionWorkspace(project, chat(null), chat(null))?.id).toBe(1)
    expect(specSessionWorkspace({ ...project, workspaces: [] }, chat(null))).toBeNull()
  })
})
