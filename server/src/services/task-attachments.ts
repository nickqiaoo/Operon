// Images on a board task: on its description (tasks.attachments) and on comments
// (the activity row's meta.attachments). They are stored attachment paths, the
// same thing a chat file part carries, so the agent gets them as file parts.

import type { FileUIPart } from 'ai'
import { parseAttachmentUrl } from './attachment-store.js'
import type { TaskActivity, TaskAttachment } from '../types/task.js'

const MAX_ATTACHMENTS = 20

/**
 * Keeps only well-formed entries that point into the attachment store. Anything
 * else (a remote URL, a data: URL, a malformed object) is dropped, so what reaches
 * the agent is always bytes this node holds.
 */
export function sanitizeTaskAttachments(raw: unknown): TaskAttachment[] {
  if (!Array.isArray(raw)) return []
  const out: TaskAttachment[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { url, mediaType, filename } = item as Record<string, unknown>
    if (typeof url !== 'string' || !parseAttachmentUrl(url)) continue
    if (typeof mediaType !== 'string' || !mediaType.startsWith('image/')) continue
    out.push({ url, mediaType, ...(typeof filename === 'string' && filename ? { filename } : {}) })
    if (out.length >= MAX_ATTACHMENTS) break
  }
  return out
}

export function taskAttachmentFiles(attachments: TaskAttachment[] | undefined): FileUIPart[] {
  return (attachments ?? []).map((a) => ({
    type: 'file',
    url: a.url,
    mediaType: a.mediaType,
    ...(a.filename ? { filename: a.filename } : {}),
  }))
}

/** A comment's images, as written by commentOnTaskAsHuman. */
export function activityAttachments(activity: Pick<TaskActivity, 'meta'>): TaskAttachment[] {
  return sanitizeTaskAttachments(activity.meta?.attachments)
}
