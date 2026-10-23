import type { SpecChatRef } from '@shared/spec'
import type { Project } from '@/stores/project-store'

/** A reclaimed execution worktree falls back within the same project. */
export function specSessionWorkspace(project: Project, chat?: SpecChatRef | null, sourceChat?: SpecChatRef | null) {
  return project.workspaces.find((workspace) => workspace.id === chat?.workspaceId) ??
    project.workspaces.find((workspace) => chat?.cwd != null && workspace.worktreePath === chat.cwd) ??
    project.workspaces.find((workspace) => workspace.id === sourceChat?.workspaceId) ??
    project.workspaces.find((workspace) => workspace.worktreePath === project.rootPath) ??
    project.workspaces[0] ?? null
}
