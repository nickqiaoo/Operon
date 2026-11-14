/**
 * A new workspace from a conversation: a new branch in its own worktree, in the
 * conversation's own project. Only makes it; handing work to it is the caller's next
 * step (external_agent_run's `workspace_id`).
 */
import type { ChatStorageAdapter, ProjectStorageAdapter } from '../storage/interface.js'
import { provisionWorkspace } from './workspace-provision.js'

export type ChatWorkspaceStorage = Pick<ChatStorageAdapter, 'getChatMeta'> &
  Pick<ProjectStorageAdapter, 'getProject' | 'getWorkspace' | 'createWorkspace'>

export async function createChatWorkspace(
  storage: ChatWorkspaceStorage,
  chatId: number,
  input: { name: string; base?: string },
) {
  const workspaceId = storage.getChatMeta(chatId)?.workspaceId
  const own = workspaceId ? storage.getWorkspace(workspaceId) : null
  if (!own) throw new Error('This conversation is not in a project workspace, so there is no project to add one to.')
  const ws = await provisionWorkspace(storage, { projectId: own.projectId, name: input.name, ...(input.base ? { base: input.base } : {}) })
  return {
    workspace_id: ws.id, name: ws.name, branch: ws.branchName, worktree_path: ws.worktreePath,
    ...(input.base ? { base_branch: input.base } : {}),
  }
}
