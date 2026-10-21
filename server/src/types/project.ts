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

/** The board task whose agent runs in a workspace — a dispatched task, a spec or one of its tickets. */
export interface WorkspaceTask {
  id: number
  number: number
  title: string
  status: string
  /** Set on a spec's ticket: the spec it belongs to. */
  parentTaskId: number | null
  /** Set on a spec. */
  specStage: string | null
  /** A spec's conversation — the chat it was started from, where the user talks to it. */
  sourceChat?: WorkspaceChat | null
  /** A spec's coordinator session — its working log. */
  coordinatorChat?: WorkspaceChat | null
  /**
   * A spec's tickets whose worktree is gone (they landed, or were dropped): no
   * workspace row lists them any more, but their sessions still open.
   */
  finishedTickets?: Array<{ id: number; number: number; title: string; status: string; chat: WorkspaceChat }>
}

/** A conversation the sidebar opens, in its own workspace (or the spec's, once that is gone). */
export interface WorkspaceChat {
  chatId: number
  workspaceId: number | null
  title: string
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
