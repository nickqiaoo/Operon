export interface Project {
  id: number
  name: string
  rootPath: string
  createdAt: number
  updatedAt: number
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
