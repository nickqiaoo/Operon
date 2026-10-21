/**
 * A spec's change branch: its name, and how a finished ticket lands on it.
 *
 * Every spec owns `operon/task-<N>`, cut off the default branch when it starts.
 * Its files live there, every ticket branch is cut from its tip, and gate 2
 * merges it into the default branch.
 */

import type { ProjectStorageAdapter, TaskStorageAdapter } from '../../storage/interface.js'
import { commit, mergeBranch } from '../git.js'

/** Who lands a ticket — the ticket's reviewer passing it, or a person marking it Done. */
export interface ChangeActor {
  type: 'human' | 'agent'
  id: number | null
  name: string
}

/** Change branch name for a task. */
export function changeBranchName(taskNumber: number): string {
  return `operon/task-${taskNumber}`
}

export interface MergeChildResult {
  parentTaskNumber: number
  mergedBranch: string
  sha: string
}

function isNothingToCommit(err: unknown): boolean {
  return /nothing to commit|no changes added to commit|working tree clean/i.test(
    err instanceof Error ? err.message : String(err),
  )
}

/**
 * Merge a finished ticket's branch into its spec's change branch. Anything the
 * implementer left uncommitted in the ticket worktree is committed first so the
 * merge brings it in. A conflict aborts cleanly and throws MergeConflictError
 * (from git.ts); the caller decides who resolves it. Records activity on both
 * tasks.
 */
export async function mergeChildIntoParent(
  storage: TaskStorageAdapter & Pick<ProjectStorageAdapter, 'getWorkspace'>,
  childTaskId: number,
  actor: ChangeActor,
): Promise<MergeChildResult> {
  const child = storage.taskGet(childTaskId)
  if (!child) throw new Error(`Task ${childTaskId} not found`)
  if (child.parentTaskId == null) throw new Error(`Task #${child.number} is not a subtask`)
  const parent = storage.taskGet(child.parentTaskId)
  if (!parent) throw new Error(`Parent task ${child.parentTaskId} not found`)
  if (parent.specStage == null) throw new Error(`Task #${child.number} is not a ticket of a spec`)
  if (!child.branchName) throw new Error(`Subtask #${child.number} has no branch to merge`)
  if (parent.workspaceId == null) {
    throw new Error(`Parent #${parent.number} has no change-branch worktree`)
  }
  const parentWs = storage.getWorkspace(parent.workspaceId)
  if (!parentWs) throw new Error(`Parent workspace ${parent.workspaceId} not found`)

  if (child.workspaceId != null) {
    const childWs = storage.getWorkspace(child.workspaceId)
    if (childWs) {
      try {
        await commit(childWs.worktreePath, `task #${child.number}: finalize before merge`, {
          includeUnstaged: true,
        })
      } catch (err) {
        if (!isNothingToCommit(err)) throw err
      }
    }
  }

  const sha = await mergeBranch(
    parentWs.worktreePath,
    child.branchName,
    `Merge subtask #${child.number} into ${parent.branchName}`,
  )

  storage.taskAppendActivity(parent.id, {
    kind: 'system',
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    body: `Merged subtask #${child.number} into \`${parent.branchName}\``,
    meta: { event: 'subtask.merged', number: child.number, branch: parent.branchName, mergedBranch: child.branchName, sha },
  })
  storage.taskAppendActivity(child.id, {
    kind: 'system',
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    body: `Merged into parent \`${parent.branchName}\``,
    meta: { event: 'parent.merged', branch: parent.branchName, sha },
  })
  return { parentTaskNumber: parent.number, mergedBranch: child.branchName, sha }
}
