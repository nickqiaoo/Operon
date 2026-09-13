import type {
  ChannelStorageAdapter,
  NotificationStorageAdapter,
  ProjectStorageAdapter,
  TaskStorageAdapter,
} from '../../storage/interface.js'
import type { Task } from '../../types/task.js'
import { getSaasConfig } from '../../gateway/saas/config.js'
import { completeTaskAfterHumanReview, wakeTaskBinding } from '../../services/channel/agent-orchestrator.js'
import { handlePermissionResponse } from '../../services/ai/approval.js'
import { notifyTaskStatusChange } from '../../services/notification-service.js'
import { broadcastTask } from '../../services/task-events.js'
import {
  createIssueComment,
  getPullRequest,
  hasWriteAccess,
  parseRepoFull,
  replyToReviewComment,
  type RepoRef,
} from '../../services/integrations/github-app.js'
import { answersFor } from './answers.js'
import { recordNonOwnerComment, setReplyTarget } from './task-surface-bridge.js'
import type { InboundMeta } from './inbound-linear.js'

// GitHub PR events → task actions (docs/linear-github/design.md §8.4, §8.5).

type Storage = TaskStorageAdapter & ChannelStorageAdapter & ProjectStorageAdapter & NotificationStorageAdapter

const MARKER = /<!--\s*operon-task:\s*(\d+)@([A-Za-z0-9_-]+)\s*-->/

export function taskMarker(taskId: number, nodeId: string): string {
  return `<!-- operon-task: ${taskId}@${nodeId} -->`
}

export function parseTaskMarker(body: string | null | undefined): { taskId: number; nodeId: string } | null {
  const m = body ? MARKER.exec(body) : null
  return m ? { taskId: Number(m[1]), nodeId: m[2]! } : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

function pick(obj: unknown, path: string): unknown {
  let cur = obj
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function lastLines(text: string, n: number): string {
  const lines = text.trimEnd().split('\n')
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

function stripMention(text: string, slug: string | undefined): string {
  if (!slug) return text.trim()
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`@${escaped}\\b`, 'gi'), '').trim()
}

async function findTaskForPR(storage: Storage, repo: RepoRef, number: number): Promise<Task | null> {
  const key = `${repo.owner}/${repo.name}#${number}`
  const surface = storage.taskSurfaceFind('github_pr', key)
  if (surface) return storage.taskGet(surface.taskId)
  // Not attached yet (a PR opened from another machine of ours, or before a
  // restart): the body carries the marker submit_pull_request wrote.
  const pr = await getPullRequest(repo, number).catch(() => null)
  const marker = parseTaskMarker(pr?.body)
  if (!pr || !marker) return null
  const ourNode = getSaasConfig().nodeId
  if (ourNode && marker.nodeId !== ourNode) return null
  const task = storage.taskGet(marker.taskId)
  if (!task) return null
  storage.taskSurfaceUpsert({
    taskId: task.id,
    kind: 'github_pr',
    externalId: key,
    url: pr.url,
    meta: { repo: `${repo.owner}/${repo.name}`, number, head: pr.head, base: pr.base, state: pr.state, merged: pr.merged },
  })
  return task
}

export async function handleGithubEvent(storage: Storage, meta: InboundMeta, payload: unknown, appSlug?: string): Promise<void> {
  const repoFull = str(pick(payload, 'repository.full_name'))
  const repo = parseRepoFull(repoFull)
  if (!repo) return
  const action = str(pick(payload, 'action'))
  const number = Number(pick(payload, 'pull_request.number') ?? pick(payload, 'issue.number') ?? 0)
  if (!number) return
  const key = `${repoFull}#${number}`

  if (meta.event === 'pull_request') {
    const task = await findTaskForPR(storage, repo, number)
    if (!task) return
    const merged = pick(payload, 'pull_request.merged') === true
    const mergedBy = str(pick(payload, 'pull_request.merged_by.login'))
    storage.taskSurfaceUpsert({
      taskId: task.id,
      kind: 'github_pr',
      externalId: key,
      meta: { state: action === 'reopened' ? 'open' : 'closed', merged },
    })
    if (action === 'closed' && merged && task.status !== 'done' && task.status !== 'cancelled') {
      // A merge is the human sign-off (design §11.3); the local branch work is
      // just the parent's own finalization, so the owner gate does not apply.
      const res = await completeTaskAfterHumanReview(task.id, { type: 'human', id: null, name: mergedBy ? `@${mergedBy}` : 'GitHub' })
      if (res.ok) {
        notifyTaskStatusChange(storage, task, 'done', task.status)
      } else {
        storage.taskAppendActivity(task.id, {
          kind: 'system',
          actorType: 'system',
          actorName: 'system',
          body: `PR #${number} merged, but the task could not be finalized: ${res.reason}`,
          meta: { event: 'pr.finalizeFailed', number, reason: res.reason, source: 'github_pr', pr: key },
        })
      }
    } else if (action === 'closed') {
      storage.taskAppendActivity(task.id, {
        kind: 'system',
        actorType: 'system',
        actorName: 'system',
        body: `PR #${number} closed without merge`,
        meta: { event: 'pr.closed', number, source: 'github_pr', pr: key },
      })
    } else if (action === 'reopened') {
      storage.taskAppendActivity(task.id, {
        kind: 'system',
        actorType: 'system',
        actorName: 'system',
        body: `PR #${number} reopened`,
        meta: { event: 'pr.reopened', number, source: 'github_pr', pr: key },
      })
    }
    broadcastTask(storage, task.id)
    return
  }

  // Comments: issue_comment on a PR, review comments, and reviews with a body.
  const isReviewComment = meta.event === 'pull_request_review_comment'
  const isReview = meta.event === 'pull_request_review'
  if (!isReviewComment && !isReview && meta.event !== 'issue_comment') return
  if (action !== 'created' && !(isReview && action === 'submitted')) return
  const rawBody = str(isReview ? pick(payload, 'review.body') : pick(payload, 'comment.body'))
  const login = str(pick(payload, 'sender.login')) || str(pick(payload, 'comment.user.login'))
  const text = stripMention(rawBody, appSlug)
  if (!text) return

  const task = await findTaskForPR(storage, repo, number)
  if (!task) return // not our PR

  // The write-permission gate keeps strangers out (design §8.4 step 3).
  if (!login || !(await hasWriteAccess(repo, login).catch(() => false))) {
    console.log(`[Surfaces] ignoring PR ${key} comment from @${login || '?'} (no write access)`)
    return
  }

  const commentId = Number(pick(payload, 'comment.id') ?? 0)
  const replyTo = isReviewComment ? Number(pick(payload, 'comment.in_reply_to_id') ?? commentId) : undefined
  const location = isReviewComment
    ? {
        path: str(pick(payload, 'comment.path')),
        line: pick(payload, 'comment.line') ?? pick(payload, 'comment.original_line'),
        diffHunk: str(pick(payload, 'comment.diff_hunk')),
      }
    : undefined
  const authorName = `@${login}`
  const activityMeta = { pr: key, commentId, path: location?.path, line: location?.line, event: meta.event }

  // Only the task's owner steers the agent (design §8.5); everyone else is
  // recorded and acknowledged.
  if (meta.actor !== 'owner') {
    recordNonOwnerComment(task.id, 'github_pr', authorName, text, activityMeta)
    broadcastTask(storage, task.id)
    // One short ack per thread so the reviewer knows a person, not the agent, will follow up.
    const already = storage.taskListActivity(task.id).some(
      (a) => a.meta?.ackedThread === (replyTo ?? commentId) && a.meta?.pr === key,
    )
    if (!already) {
      try {
        if (isReviewComment && replyTo) await replyToReviewComment(repo, number, replyTo, 'Noted — waiting for the task owner to review this.')
        else await createIssueComment(repo, number, 'Noted — waiting for the task owner to review this.')
        storage.taskAppendActivity(task.id, {
          kind: 'system',
          actorType: 'system',
          actorName: 'system',
          body: `Acknowledged ${authorName} on PR #${number}`,
          meta: { event: 'pr.acknowledged', author: authorName, number, source: 'github_pr', pr: key, ackedThread: replyTo ?? commentId },
        })
      } catch (err) {
        console.warn('[Surfaces] github ack failed:', err instanceof Error ? err.message : err)
      }
    }
    return
  }

  storage.taskAppendActivity(task.id, {
    kind: 'comment',
    actorType: 'human',
    actorName: `${authorName} (GitHub)`,
    body: text,
    meta: { ...activityMeta, source: 'github_pr', actor: meta.actor },
  })
  broadcastTask(storage, task.id)
  setReplyTarget(task.id, {
    kind: 'github_pr',
    ref: key,
    github: isReviewComment && replyTo ? { reviewCommentId: replyTo } : {},
  })

  const pending = storage.surfacePendingListByTask(task.id)
  if (pending.length > 0) {
    let resolved = 0
    for (const a of answersFor(pending, text)) {
      if (handlePermissionResponse(a.approvalId, a.outcome, a.chatId)) resolved += 1
      storage.surfacePendingDelete(a.approvalId)
    }
    if (resolved > 0) return
  }
  if (task.bindingId == null) {
    await createIssueComment(repo, number, 'My session for this task has ended on the machine that opened it. Delegate the issue again in Linear to continue.').catch(() => undefined)
    return
  }
  const where = location?.path ? ` on \`${location.path}\`${location.line != null ? ` line ${String(location.line)}` : ''}` : ''
  const hunk = location?.diffHunk ? `\n\n\`\`\`diff\n${lastLines(location.diffHunk, 12)}\n\`\`\`` : ''
  await wakeTaskBinding(task.bindingId, `From ${authorName} on GitHub pull request #${number}${where}:${hunk}\n\n${text}`)
}
