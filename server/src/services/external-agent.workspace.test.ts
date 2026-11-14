/** Which workspace a conversation's external agent works in. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../types/project.js'

interface Meta { workspaceId?: number; providerId?: string; model?: string; updatedAt?: number; metadata?: Record<string, unknown> }

const chats = vi.hoisted(() => new Map<number, Meta>())
const workspaces = vi.hoisted(() => new Map<number, Workspace>())

vi.mock('./ai/state.js', () => {
  let next = 100
  return {
    getChatStorage: () => ({
      getChatMeta: (id: number) => chats.get(id),
      createChat: (input: Meta) => { const id = next++; chats.set(id, { ...input }); return id },
      updateChatMetadata: (id: number, metadata: Record<string, unknown>) => {
        const meta = chats.get(id)
        if (meta) meta.metadata = { ...meta.metadata, ...metadata }
      },
    }),
    getProjectStorage: () => ({ getWorkspace: (id: number) => workspaces.get(id) ?? null }),
  }
})
vi.mock('./ai/chat-delivery.js', () => ({ deliverChatMessage: async () => ({ delivery: 'started', requestId: 'turn-1' }) }))
vi.mock('./ai/session-ops.js', () => ({ abortChat: () => false }))
vi.mock('./ai/providers.js', () => ({ getProviderModels: async () => ({}) }))
vi.mock('./ai/chat-turn-lifecycle.js', () => ({ onChatTurnStarted: () => () => {}, onChatTurnFinished: () => () => {} }))
vi.mock('./ai/chat-pending-input.js', () => ({ listPendingApprovals: () => [] }))
vi.mock('./external-agent-notifications.js', () => ({ enqueueExternalAgentResult: () => {} }))

const { createExternalAgent } = await import('./external-agent.js')

const ws = (id: number, projectId: number, name: string): Workspace =>
  ({ id, projectId, name, branchName: name, worktreePath: `/wt/${name}`, createdAt: 0, updatedAt: 0 })

const run = (parent: { chatId: number; workspaceId?: number }) =>
  createExternalAgent({ parent, providerId: 'codex', model: 'gpt', description: 'Fix', prompt: 'Fix it' })

describe('createExternalAgent workspace', () => {
  beforeEach(() => {
    chats.clear()
    workspaces.clear()
    workspaces.set(6, ws(6, 5, 'main'))
    workspaces.set(66, ws(66, 5, 'login'))
    workspaces.set(77, ws(77, 9, 'other-project'))
    chats.set(42, { workspaceId: 6 })
  })

  it("joins the parent's workspace by default, and says nothing about where", async () => {
    const result = await run({ chatId: 42 })
    expect(chats.get(result.chat_id)?.workspaceId).toBe(6)
    expect(result).not.toHaveProperty('worktree_path')
  })

  it('works in another workspace of the same project, and reports its branch and worktree', async () => {
    const result = await run({ chatId: 42, workspaceId: 66 })
    expect(chats.get(result.chat_id)?.workspaceId).toBe(66)
    expect(result).toMatchObject({ workspace_id: 66, branch: 'login', worktree_path: '/wt/login' })
  })

  it("refuses a workspace of another project, or one that doesn't exist, before creating anything", async () => {
    await expect(run({ chatId: 42, workspaceId: 77 })).rejects.toThrow("not in this conversation's project")
    await expect(run({ chatId: 42, workspaceId: 404 })).rejects.toThrow('There is no workspace 404')
    expect([...chats.keys()]).toEqual([42])
  })
})
