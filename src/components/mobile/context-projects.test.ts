import { describe, expect, it } from 'vitest'
import type { Project, Workspace, WorkspaceTask } from '@/stores/project-store'
import { contextProjectGroups } from './context-projects'

const spec: WorkspaceTask = {
  id: 10, number: 1, title: 'Navigation', status: 'in_progress',
  parentTaskId: null, specStage: 'building',
}
const workspace = (id: number, task?: WorkspaceTask): Workspace => ({
  id, name: `workspace ${id}`, branchName: 'main', worktreePath: `/repo/${id}`, task,
})
const project: Project = {
  id: 1, name: 'App', rootPath: '/repo', createdAt: 0, updatedAt: 0,
  workspaces: [
    workspace(2, spec),
    workspace(3, { ...spec, id: 11, number: 2, parentTaskId: 10, specStage: null }),
    workspace(1),
  ],
}

describe('mobile context project groups', () => {
  it('shows a stopped Spec even if its workspace is absent', () => {
    const stopped = { ...spec, specStage: 'stopped' }
    const data = { ...project, workspaces: [workspace(1)], specs: [stopped] }
    expect(contextProjectGroups(data, [], []).specs).toEqual([stopped])
    expect(contextProjectGroups(data, [10], []).specs).toEqual([])
  })
  it('lists Specs by title and keeps their execution worktrees out of ordinary choices', () => {
    const result = contextProjectGroups(project, [], [])
    expect(result.workspaces.map((w) => w.id)).toEqual([1])
    expect(result.specs).toEqual([spec])
  })

  it('respects hidden and archived Specs, including their ticket worktrees', () => {
    expect(contextProjectGroups(project, [10], []).specs).toEqual([])
    const archived = { ...project, workspaces: [workspace(2, { ...spec, archivedAt: 1 }), project.workspaces[1]] }
    expect(contextProjectGroups(archived, [], [])).toEqual({ workspaces: [], specs: [] })
  })

  it('includes a completed Spec only when explicitly shown, without needing a workspace', () => {
    const completed = { ...spec, specStage: 'done' as const, status: 'done' }
    const history = { ...project, workspaces: [], specs: [completed] }
    expect(contextProjectGroups(history, [], []).specs).toEqual([])
    expect(contextProjectGroups(history, [], [10]).specs).toEqual([completed])
    expect(contextProjectGroups(history, [10], [10]).specs).toEqual([])
  })

  it('preserves an orphan ticket as an ordinary workspace, like the desktop sidebar', () => {
    const orphan = { ...project, workspaces: [project.workspaces[1]] }
    expect(contextProjectGroups(orphan, [], []).workspaces).toEqual(orphan.workspaces)
  })
})
