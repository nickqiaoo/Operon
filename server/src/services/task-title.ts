import type { ProjectStorageAdapter, TaskStorageAdapter } from '../storage/interface.js'
import { runOneShotPrompt } from './ai/one-shot.js'
import { getCommitMessageConfig } from './commit-message-config.js'
import { broadcastTask } from './task-events.js'

/**
 * A task created with its title left blank gets one from its description: a
 * placeholder right away (the description's first line), then a generated one
 * swapped in when the model answers — unless the title was edited meanwhile.
 */

export const TASK_TITLE_MAX_CHARS = 60
const MAX_DESCRIPTION_CHARS = 8_000
const GENERATION_TIMEOUT_MS = 60_000
/** How long Create & Dispatch waits for the title before sending the placeholder. */
export const DISPATCH_TITLE_WAIT_MS = 5_000

export type TaskTitleStorage = TaskStorageAdapter & Pick<ProjectStorageAdapter, 'getProject'>

/** Tasks whose title is being generated → the generation, so dispatch can wait on it. */
const pending = new Map<number, Promise<void>>()

export function isTaskTitlePending(taskId: number): boolean {
  return pending.has(taskId)
}

function truncate(text: string, max = TASK_TITLE_MAX_CHARS): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

/** One line of markdown as plain text: no heading / list / quote markers, emphasis, code ticks or link targets. */
function stripMarkdownLine(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)+/, '')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_([^_\s][^_]*?)_(?!\w)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The placeholder: the description's first line with text in it, as plain text, ≤ 60 chars. */
export function placeholderTaskTitle(description: string): string {
  let inFence = false
  for (const raw of description.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const line = stripMarkdownLine(raw)
    if (line && !/^[-*_=\s|:]+$/.test(line)) return truncate(line)
  }
  return 'Untitled task'
}

/** What the model returned, as one title line: no fences, quotes, "Title:" prefix, or trailing period. */
export function cleanGeneratedTitle(raw: string): string {
  const line =
    raw
      .replace(/```[\w-]*/g, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  const cleaned = stripMarkdownLine(line)
    .replace(/^(?:task\s+)?title\s*[:：]\s*/i, '')
    .replace(/^标题\s*[:：]\s*/, '')
    .replace(/^["'`“”‘’「」『』]+|["'`“”‘’「」『』]+$/g, '')
    .replace(/[.。]$/, '')
    .trim()
  return cleaned ? truncate(cleaned) : ''
}

const RULES = [
  'Output ONLY the title, on a single line — no explanation, no quotes, no prefix like "Title:", no trailing period.',
  `At most ${TASK_TITLE_MAX_CHARS} characters. Short and specific, like an issue tracker title.`,
  'Write it in the same language as the description (a Chinese description gets a Chinese title).',
  'Do NOT call any tools — base the title solely on the description below.',
].join('\n- ')

async function generateTitle(description: string, cwd: string, signal: AbortSignal): Promise<string> {
  const config = getCommitMessageConfig()
  const providerId = config.providerId || 'claude'
  const modelId = config.modelId || undefined
  const body = description.length > MAX_DESCRIPTION_CHARS ? `${description.slice(0, MAX_DESCRIPTION_CHARS)}\n…` : description
  const prompt = `Write a title for the task described below.\n\nRules:\n- ${RULES}\n\n# Description\n${body}`
  return cleanGeneratedTitle(await runOneShotPrompt({ prompt, cwd, providerId, modelId, signal }))
}

/** Put the generated title in, unless the placeholder was edited meanwhile. True when it went in. */
export function applyGeneratedTitle(storage: TaskTitleStorage, taskId: number, placeholder: string, title: string): boolean {
  if (!title || title === placeholder) return false
  if (!storage.taskReplaceAutoTitle(taskId, placeholder, title)) return false
  broadcastTask(storage, taskId)
  return true
}

/**
 * Start generating the title of a task created with `titleSource: 'auto'`. Never
 * rejects: no model, a failure or a timeout leaves the placeholder, logged only.
 */
export function startTaskTitleGeneration(storage: TaskTitleStorage, taskId: number): Promise<void> {
  const task = storage.taskGet(taskId)
  if (!task || task.titleSource !== 'auto' || pending.has(taskId)) return pending.get(taskId) ?? Promise.resolve()
  const placeholder = task.title
  const cwd = storage.getProject(task.projectId)?.rootPath ?? process.cwd()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS)
  const run = (async () => {
    try {
      const title = await generateTitle(task.description, cwd, controller.signal)
      if (!title) {
        console.warn(`[operon] task title: model returned nothing for task=${taskId}; keeping the placeholder`)
        return
      }
      if (!applyGeneratedTitle(storage, taskId, placeholder, title)) {
        console.log(`[operon] task title: task=${taskId} title was edited meanwhile; dropped the generated one`)
      }
    } catch (err) {
      console.warn(`[operon] task title: generation failed for task=${taskId}; keeping the placeholder:`, err instanceof Error ? err.message : err)
    } finally {
      clearTimeout(timer)
      pending.delete(taskId)
      // Clears the "generating" shimmer even when nothing was written.
      broadcastTask(storage, taskId)
    }
  })()
  pending.set(taskId, run)
  return run
}

/** Wait for a title being generated, up to `timeoutMs`; returns at once when none is. */
export async function waitForTaskTitle(taskId: number, timeoutMs = DISPATCH_TITLE_WAIT_MS): Promise<void> {
  const run = pending.get(taskId)
  if (!run) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([run, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))])
  clearTimeout(timer)
}
