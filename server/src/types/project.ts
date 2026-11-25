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
  /**
   * The conversation that made this workspace for an external agent it dispatched
   * (`workspace_create`). Listed under that conversation in the sidebar, never at the
   * top. Null: the user, a spec or a board task made it.
   */
  originChatId?: number | null
  /** Who named it; see `WorkspaceNameSource`. Absent on rows read before the field existed. */
  nameSource?: WorkspaceNameSource
  createdAt: number
  updatedAt: number
}

/**
 * 'user': typed, or made by a task / spec / agent. 'placeholder': a chat's
 * worktree made before anyone said what it is for; the server renames it (and
 * its branch) from the chat's messages. 'auto': that generated name went in.
 */
export type WorkspaceNameSource = 'user' | 'placeholder' | 'auto'


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
  archivedAt: number | null
  /** Provider of the task's current conversation, falling back to its assigned agent. */
  providerId?: string | null
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

/**
 * A board sub-task's session, nested in the sidebar under the session of its
 * parent task's agent (as an external agent is under the chat that dispatched
 * it). Spec tickets are not listed: a spec shows its own.
 */
export interface TaskChildSession {
  taskId: number
  number: number
  title: string
  status: string
  /** The parent task agent's conversation. */
  parentChatId: number
  chatId: number
  /** Where the sub-task runs: its own worktree, or the shared workspace. */
  workspaceId: number | null
  providerId: string | null
  modelId: string | null
  updatedAt: number
}

/** A conversation the sidebar opens, in its own workspace (or the spec's, once that is gone). */
export interface WorkspaceChat {
  providerId?: string | null
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
  /** See `Workspace.originChatId`. */
  originChatId?: number
  /** Defaults to 'user'. */
  nameSource?: WorkspaceNameSource
}
