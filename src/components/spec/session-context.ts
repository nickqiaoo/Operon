import type { SpecChatRef } from '@shared/spec'
import type { Project } from '@/stores/project-store'

/**
 * Where a Spec conversation opens: its own workspace, found by id or by its
 * directory. Null once that is removed — the conversation is history then, and
 * continuing it in some other checkout would put the agent in the wrong tree.
 */
export function specSessionWorkspace(project: Project, chat: SpecChatRef | null | undefined) {
  if (!chat) return null
  return project.workspaces.find((workspace) => workspace.id === chat.workspaceId) ??
    project.workspaces.find((workspace) => chat.cwd != null && workspace.worktreePath === chat.cwd) ??
    null
}
