export interface GitFileStatus {
  path: string
  status: string
  index: string
  workingDir: string
}

export interface GitStatusSummary {
  current: string | null
  ahead: number
  behind: number
  files: GitFileStatus[]
  staged: GitFileStatus[]
  unstaged: GitFileStatus[]
  untracked: GitFileStatus[]
}

export interface GitWorktreeEntry {
  path: string
  branch: string | null
  head: string | null
  detached: boolean
}
