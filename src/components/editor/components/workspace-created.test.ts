import { describe, expect, it } from 'vitest'
import { createdWorkspace } from './WorkspaceCreatedRenderer'
import type { ToolPartLike } from './toolName'

const payload = JSON.stringify({ workspace_id: 90, name: 'login', branch: 'login', worktree_path: '/wt/login' })
const part = (toolName: string, output: unknown) => ({ toolName, input: { name: 'login' }, output }) as unknown as ToolPartLike

describe('createdWorkspace', () => {
  it.each([
    'mcp__external_agent__workspace_create',
    'external_agent_workspace_create',
    'workspace_create',
  ])('reads the workspace from %s', (name) => {
    expect(createdWorkspace(part(name, { content: [{ type: 'text', text: payload }] })))
      .toEqual({ workspaceId: 90, name: 'login', branch: 'login' })
  })

  it('is null while streaming, on a failure, for the assistant prose answer, or another tool', () => {
    expect(createdWorkspace(part('mcp__external_agent__workspace_create', undefined))).toBeNull()
    expect(createdWorkspace(part('mcp__external_agent__workspace_create', 'A worktree already exists at /wt/login; pick another name.'))).toBeNull()
    expect(createdWorkspace(part('mcp__assistant__workspace_create', 'Created workspace 90 "login" in project "app"'))).toBeNull()
    expect(createdWorkspace(part('mcp__external_agent__external_agent_status', payload))).toBeNull()
  })
})
