export interface Project {
  id: number
  name: string
  rootPath: string
  createdAt: number
  updatedAt: number
  /** When the user pinned it to the top of the list; null when not pinned. */
  pinnedAt: number | null
}

export interface Workspace {
  id: number
  projectId: number
  name: string
  branchName: string
  worktreePath: string
  createdAt: number
  updatedAt: number
}

export interface CreateProjectInput {
  name: string
  rootPath: string
}

export interface CreateWorkspaceInput {
  name: string
  branchName: string
  worktreePath: string
}
