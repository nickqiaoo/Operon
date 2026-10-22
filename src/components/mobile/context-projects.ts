import type { Project } from '@/stores/project-store'
import { groupSpecWorkspaces, sidebarSpecShortcuts } from '@/components/project/workspace-groups'

/** Share desktop visibility rules; execution worktrees stay inside their Spec. */
export function contextProjectGroups(project: Project, hiddenIds: readonly number[], shownIds: readonly number[]) {
  const { top } = groupSpecWorkspaces(project.workspaces, hiddenIds)
  return {
    workspaces: top.filter((workspace) => workspace.task?.specStage == null),
    specs: [
      ...top.flatMap((workspace) => workspace.task?.specStage != null ? [workspace.task] : []),
      ...sidebarSpecShortcuts(project, shownIds, hiddenIds),
    ],
  }
}
