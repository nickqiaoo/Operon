import { randomUUID } from 'node:crypto'
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import type { CanvasWorkflowStorageAdapter, ChatStorageAdapter, CronjobStorageAdapter, ProjectStorageAdapter } from '../storage/interface.js'
import type {
  CronjobSchedule,
  CronjobTask,
  CronjobUpsertInput,
  CronjobRunResult,
  CronjobExecutionHistoryItem,
} from '../types/cronjob.js'
import { startChat, getSessionManager } from './ai.js'
import { readPreparedTextStreamParts } from './ai/prepared-stream-parts.js'
import { createUiStreamFromTextParts } from './ai/text-stream-part-to-ui.js'
import { startCanvasWorkflowExecution } from './canvas-workflow.js'
import { ChatHistoryService } from './chat-history.js'

const DEFAULT_DAILY_DAYS = [1, 2, 3, 4, 5]
const MAX_OUTPUT_CHARS = 8000
const HISTORY_TITLE_MAX_CHARS = 160
const WORKFLOW_POLL_INTERVAL_MS = 2000
const WORKFLOW_POLL_TIMEOUT_MS = 30 * 60_000 // 30 minutes
type CronjobStorage = CronjobStorageAdapter & ChatStorageAdapter & CanvasWorkflowStorageAdapter & ProjectStorageAdapter

const isValidTime = (value: string): boolean => /^([01]\d|2[0-3]):([0-5]\d)$/.test(value)

const normalizeDays = (days: number[]): number[] =>
  Array.from(new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))).sort()

const normalizeDailySchedule = (schedule: CronjobSchedule): CronjobSchedule => {
  const parsedTime = parseTime(schedule.time)
  if (!parsedTime) {
    throw new Error('Start time must be between 00:00 and 23:59')
  }
  const time = schedule.time
  const days = normalizeDays(schedule.days)
  const result: CronjobSchedule = {
    type: 'daily',
    time,
    days: days.length > 0 ? days : [...DEFAULT_DAILY_DAYS],
  }
  if (schedule.intervalMinutes != null && Number.isFinite(schedule.intervalMinutes) && schedule.intervalMinutes > 0) {
    const parsedEndTime = parseTime(schedule.endTime ?? '')
    if (!parsedEndTime) {
      throw new Error('End time must be between 00:00 and 23:59')
    }
    if (toMinutes(parsedEndTime) <= toMinutes(parsedTime)) {
      throw new Error('End time must be later than start time')
    }
    result.intervalMinutes = Math.max(1, Math.floor(schedule.intervalMinutes))
    result.endTime = schedule.endTime
  }
  return result
}

const normalizeSchedule = (schedule: CronjobSchedule): CronjobSchedule =>
  normalizeDailySchedule(schedule)

const truncateText = (text: string, maxChars = MAX_OUTPUT_CHARS): string =>
  text.length > maxChars ? `${text.slice(0, maxChars)}...` : text

const createUserMessage = (prompt: string): UIMessage => ({
  id: randomUUID(),
  role: 'user',
  parts: [{ type: 'text', text: prompt.trim() }],
})

const createErrorAssistantMessage = (message: string): UIMessage => {
  const trimmed = message.trim()
  return {
    id: randomUUID(),
    role: 'assistant',
    parts: [{ type: 'text', text: `Error: ${trimmed || 'Unknown error'}` }],
  }
}

const collectAssistantMessage = async (
  stream: ReadableStream<UIMessageChunk>
): Promise<UIMessage | undefined> => {
  let lastMessage: UIMessage | undefined
  for await (const message of readUIMessageStream({ stream })) {
    lastMessage = message
  }
  return lastMessage
}

const extractAssistantText = (messages: UIMessage[]): string => {
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!assistant?.parts) return ''
  return assistant.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
}

/**
 * Create a chat entry in DB for cronjob execution history and return the numeric chatId.
 * Returns undefined if persistence fails.
 */
const persistCronjobChat = (
  storage: CronjobStorage,
  job: CronjobTask,
  messages: UIMessage[],
  chatId: number | null = null,
  baseRevision = 0
): { chatId: number; revision: number } | undefined => {
  try {
    const history = new ChatHistoryService(storage)
    const result = history.patchChat(
      chatId,
      baseRevision,
      0,
      messages,
      'cronjob',
      job.workspaceId,
      job.modelId,
      job.providerId,
    )
    if (result.success) {
      return {
        chatId: result.chatId,
        revision: result.revision,
      }
    }
    console.error('[Cronjob] Failed to persist chat history: conflict')
    return undefined
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[Cronjob] Failed to persist chat history: ${errorMessage}`)
    return undefined
  }
}

const persistCronjobRun = (
  storage: CronjobStorage,
  entry: CronjobExecutionHistoryItem
): void => {
  try {
    storage.addCronjobRun(entry)
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[Cronjob] Failed to persist run history: ${errorMessage}`)
  }
}

const toHistoryTitle = (text: string, fallback: string): string => {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback
  return normalized.slice(0, HISTORY_TITLE_MAX_CHARS)
}

const parseTime = (value: string): { hour: number; minute: number } | null => {
  if (!isValidTime(value)) return null
  const [h, m] = value.split(':')
  return { hour: Number(h), minute: Number(m) }
}

const toMinutes = (value: { hour: number; minute: number }): number =>
  value.hour * 60 + value.minute

const computeNextDailyRun = (
  schedule: CronjobSchedule,
  now: number
): number | undefined => {
  const parsed = parseTime(schedule.time)
  if (!parsed) return undefined
  const days = schedule.days.length > 0 ? schedule.days : DEFAULT_DAILY_DAYS
  const nowDate = new Date(now)
  const hasInterval = schedule.intervalMinutes != null && schedule.intervalMinutes > 0
  const intervalMs = hasInterval ? schedule.intervalMinutes! * 60_000 : 0
  const parsedEnd = hasInterval ? parseTime(schedule.endTime ?? '23:59') : null

  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(nowDate)
    candidate.setDate(nowDate.getDate() + offset)
    candidate.setHours(parsed.hour, parsed.minute, 0, 0)
    const day = candidate.getDay()
    if (!days.includes(day)) continue

    if (!hasInterval) {
      if (candidate.getTime() >= now) return candidate.getTime()
      continue
    }

    // Interval mode: find the next slot within [startTime, endTime] on this day
    const dayStart = candidate.getTime()
    const dayEnd = new Date(candidate)
    dayEnd.setHours(parsedEnd?.hour ?? 23, parsedEnd?.minute ?? 59, 0, 0)
    const dayEndTs = dayEnd.getTime()

    if (dayEndTs < now && offset === 0) continue // already past end time today

    // Find the next interval slot >= now
    const elapsed = Math.max(0, now - dayStart)
    const steps = elapsed <= 0 ? 0 : Math.ceil(elapsed / intervalMs)
    const next = dayStart + steps * intervalMs
    if (next >= now && next <= dayEndTs) return next
  }

  return undefined
}

export const computeNextRunAtForJob = (
  job: CronjobTask,
  now: number
): number | undefined => {
  if (!job.enabled) return undefined
  return computeNextDailyRun(job.schedule, now)
}

const loadCronjobs = (storage: CronjobStorage): CronjobTask[] => storage.listCronjobs()

const replaceCronjob = (storage: CronjobStorage, job: CronjobTask): CronjobTask => {
  storage.upsertCronjob(job)
  return job
}

const sanitizeText = (value: string | undefined): string => (value ?? '').trim()

const getCanvasWorkflowWorkspaceId = (
  storage: CronjobStorage,
  canvasWorkflowId: number
): number | undefined => {
  const workflow = storage.getCanvasWorkflow(canvasWorkflowId)
  if (!workflow) {
    throw new Error(`Canvas workflow not found: ${canvasWorkflowId}`)
  }
  return workflow.workspaceId
}

export const listCronjobs = (storage: CronjobStorage): CronjobTask[] => loadCronjobs(storage)

export const getCronjob = (storage: CronjobStorage, id: number): CronjobTask | undefined =>
  storage.getCronjobById(id)

export const createCronjob = (storage: CronjobStorage, input: CronjobUpsertInput): CronjobTask => {
  const now = Date.now()
  const schedule = normalizeSchedule(input.schedule)
  const name = sanitizeText(input.name) || 'New Cronjob'
  const taskType = input.taskType ?? 'chat'

  if (taskType === 'canvas-workflow') {
    const canvasWorkflowId = input.canvasWorkflowId
    if (canvasWorkflowId === undefined) {
      throw new Error('canvasWorkflowId is required for canvas-workflow task type')
    }
    const workspaceId = getCanvasWorkflowWorkspaceId(storage, canvasWorkflowId)

    const job: CronjobTask = {
      id: 0,
      name,
      enabled: input.enabled ?? true,
      taskType,
      canvasWorkflowId,
      workspaceId,
      providerId: sanitizeText(input.providerId) || '',
      prompt: sanitizeText(input.prompt) || '',
      schedule,
      createdAt: now,
      updatedAt: now,
    }

    job.nextRunAt = computeNextRunAtForJob(job, now)
    storage.upsertCronjob(job)
    return job
  }

  const prompt = sanitizeText(input.prompt)
  if (!prompt) {
    throw new Error('prompt is required')
  }
  if (!sanitizeText(input.providerId)) {
    throw new Error('providerId is required')
  }

  const job: CronjobTask = {
    id: 0,
    name,
    enabled: input.enabled ?? true,
    taskType: 'chat',
    workspaceId: input.workspaceId,
    providerId: sanitizeText(input.providerId)!,
    modelId: sanitizeText(input.modelId) || undefined,
    modeId: sanitizeText(input.modeId) || undefined,
    thinkingLevel: sanitizeText(input.thinkingLevel) || undefined,
    prompt,
    schedule,
    createdAt: now,
    updatedAt: now,
  }

  job.nextRunAt = computeNextRunAtForJob(job, now)
  storage.upsertCronjob(job)
  return job
}

export const updateCronjob = (
  storage: CronjobStorage,
  id: number,
  input: CronjobUpsertInput
): CronjobTask | undefined => {
  const current = storage.getCronjobById(id)
  if (!current) return undefined

  const now = Date.now()
  const schedule = normalizeSchedule(input.schedule)
  const name = sanitizeText(input.name) || current.name
  const taskType = input.taskType ?? current.taskType

  if (taskType === 'canvas-workflow') {
    const canvasWorkflowId = input.canvasWorkflowId
    if (canvasWorkflowId === undefined) {
      throw new Error('canvasWorkflowId is required for canvas-workflow task type')
    }
    const workspaceId = getCanvasWorkflowWorkspaceId(storage, canvasWorkflowId)

    const nextJob: CronjobTask = {
      ...current,
      name,
      enabled: input.enabled ?? true,
      taskType,
      canvasWorkflowId,
      workspaceId,
      providerId: sanitizeText(input.providerId) || '',
      prompt: sanitizeText(input.prompt) || '',
      schedule,
      updatedAt: now,
    }

    nextJob.nextRunAt = computeNextRunAtForJob(nextJob, now)
    storage.upsertCronjob(nextJob)
    return nextJob
  }

  const prompt = sanitizeText(input.prompt)
  if (!prompt) {
    throw new Error('prompt is required')
  }
  if (!sanitizeText(input.providerId)) {
    throw new Error('providerId is required')
  }

  const nextJob: CronjobTask = {
    ...current,
    name,
    enabled: input.enabled ?? true,
    taskType: 'chat',
    canvasWorkflowId: undefined,
    workspaceId: input.workspaceId,
    providerId: sanitizeText(input.providerId)!,
    modelId: sanitizeText(input.modelId) || undefined,
    modeId: sanitizeText(input.modeId) || undefined,
    thinkingLevel: sanitizeText(input.thinkingLevel) || undefined,
    prompt,
    schedule,
    updatedAt: now,
  }

  nextJob.nextRunAt = computeNextRunAtForJob(nextJob, now)
  storage.upsertCronjob(nextJob)
  return nextJob
}

export const deleteCronjob = (storage: CronjobStorage, id: number): boolean => {
  return storage.deleteCronjobById(id)
}

export const setCronjobNextRunAt = (
  storage: CronjobStorage,
  id: number,
  nextRunAt: number | undefined
): CronjobTask | undefined => {
  const job = getCronjob(storage, id)
  if (!job) return undefined
  const updated: CronjobTask = {
    ...job,
    nextRunAt,
  }
  return replaceCronjob(storage, updated)
}

export const getCronjobExecutionHistory = (
  storage: CronjobStorage,
  jobId: number
): CronjobExecutionHistoryItem[] => storage.listCronjobRuns(jobId)

const pollWorkflowRun = async (
  storage: CronjobStorage,
  runId: number
): Promise<{ status: 'success' | 'error'; outputs?: Record<string, string>; error?: string }> => {
  const deadline = Date.now() + WORKFLOW_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const run = storage.getCanvasRun(runId)
    if (!run) return { status: 'error', error: 'Workflow run not found' }
    if (run.status === 'success') return { status: 'success', outputs: run.outputs ?? undefined }
    if (run.status === 'error') return { status: 'error', error: run.error ?? 'Workflow execution failed' }
    await new Promise((resolve) => setTimeout(resolve, WORKFLOW_POLL_INTERVAL_MS))
  }
  return { status: 'error', error: 'Workflow execution timed out' }
}

const executeCanvasWorkflowCronjob = async (
  storage: CronjobStorage,
  job: CronjobTask
): Promise<{ success: boolean; cronjob?: CronjobTask; error?: string }> => {
  const startedAt = Date.now()
  const workflowId = job.canvasWorkflowId

  if (workflowId === undefined) {
    return { success: false, error: 'canvasWorkflowId is missing' }
  }

  const workflow = storage.getCanvasWorkflow(workflowId)
  if (!workflow) {
    return { success: false, error: `Canvas workflow not found: ${workflowId}` }
  }
  const executionJob = job.workspaceId === workflow.workspaceId
    ? job
    : { ...job, workspaceId: workflow.workspaceId }

  try {
    const { runId } = startCanvasWorkflowExecution(storage, workflowId)
    const result = await pollWorkflowRun(storage, runId)

    const finishedAt = Date.now()
    const outputText = result.outputs
      ? truncateText(Object.entries(result.outputs).map(([k, v]) => `[${k}]: ${v}`).join('\n\n'))
      : ''

    const lastResult: CronjobRunResult = {
      status: result.status,
      output: result.status === 'success' ? outputText : undefined,
      error: result.error,
      finishedAt,
      durationMs: finishedAt - startedAt,
    }

    const updated: CronjobTask = {
      ...executionJob,
      lastRunAt: startedAt,
      lastResult,
      updatedAt: finishedAt,
    }
    updated.nextRunAt = computeNextRunAtForJob(updated, finishedAt)
    replaceCronjob(storage, updated)

    // Create a chat entry for the workflow run history
    const chatMessages: UIMessage[] = [
      createUserMessage(`Canvas workflow execution (run ${runId})`),
      ...(result.status === 'success'
        ? [{ id: randomUUID(), role: 'assistant' as const, parts: [{ type: 'text' as const, text: outputText || 'Workflow completed' }] }]
        : [createErrorAssistantMessage(result.error ?? 'Unknown error')]),
    ]
    const persisted = persistCronjobChat(storage, executionJob, chatMessages)
    if (persisted) {
      persistCronjobRun(storage, {
        chatId: persisted.chatId,
        jobId: job.id,
        timestamp: startedAt,
        title: toHistoryTitle(
          result.status === 'success' ? (outputText || 'Workflow completed') : `Error: ${result.error ?? 'Unknown'}`,
          result.status === 'success' ? 'Workflow completed' : 'Error'
        ),
        status: result.status,
      })
    }

    return result.status === 'success'
      ? { success: true, cronjob: updated }
      : { success: false, cronjob: updated, error: result.error }
  } catch (err) {
    const finishedAt = Date.now()
    const message = err instanceof Error ? err.message : 'Canvas workflow execution failed'
    const lastResult: CronjobRunResult = {
      status: 'error',
      error: message,
      finishedAt,
      durationMs: finishedAt - startedAt,
    }
    const updated: CronjobTask = {
      ...executionJob,
      lastRunAt: startedAt,
      lastResult,
      updatedAt: finishedAt,
    }
    updated.nextRunAt = computeNextRunAtForJob(updated, finishedAt)
    replaceCronjob(storage, updated)

    const chatMessages: UIMessage[] = [
      createUserMessage(`Canvas workflow execution`),
      createErrorAssistantMessage(message),
    ]
    const persisted = persistCronjobChat(storage, executionJob, chatMessages)
    if (persisted) {
      persistCronjobRun(storage, {
        chatId: persisted.chatId,
        jobId: job.id,
        timestamp: startedAt,
        title: toHistoryTitle(`Error: ${message}`, 'Error'),
        status: 'error',
      })
    }

    return { success: false, cronjob: updated, error: message }
  }
}

export const executeCronjob = async (
  storage: CronjobStorage,
  id: number
): Promise<{ success: boolean; cronjob?: CronjobTask; error?: string }> => {
  const job = getCronjob(storage, id)
  if (!job) return { success: false, error: 'Cronjob not found' }

  if (job.taskType === 'canvas-workflow') {
    return executeCanvasWorkflowCronjob(storage, job)
  }

  if (!job.prompt.trim()) return { success: false, error: 'Cronjob prompt is empty' }

  const startedAt = Date.now()
  const userMessage = createUserMessage(job.prompt)
  let chatCtx: Awaited<ReturnType<typeof startChat>> | undefined

  try {
    chatCtx = await startChat({
      requestId: `cronjob-${job.id}-${randomUUID()}`,
      messages: [userMessage],
      providerId: job.providerId,
      modelId: job.modelId,
      modeId: job.modeId,
      thinkingLevel: job.thinkingLevel,
      workspaceId: job.workspaceId,
      tp: 'cronjob',
      skipSnapshot: true,
    })

    const assistantMessage = await collectAssistantMessage(createUiStreamFromTextParts({
      originalMessages: chatCtx.normalizedMessages,
      messageId: chatCtx.assistantMessageId,
      parts: readPreparedTextStreamParts(chatCtx.preparedParts),
    }))
    await chatCtx.persistDone

    const messages = assistantMessage ? [userMessage, assistantMessage] : [userMessage]
    const output = truncateText(extractAssistantText(messages))
    const finishedAt = Date.now()
    const lastResult: CronjobRunResult = {
      status: 'success',
      output,
      finishedAt,
      durationMs: finishedAt - startedAt,
    }

    const updated: CronjobTask = {
      ...job,
      lastRunAt: startedAt,
      lastResult,
      updatedAt: finishedAt,
    }
    updated.nextRunAt = computeNextRunAtForJob(updated, finishedAt)
    replaceCronjob(storage, updated)

    persistCronjobRun(storage, {
      chatId: chatCtx.chatId,
      jobId: job.id,
      timestamp: startedAt,
      title: toHistoryTitle(output, 'Execution'),
      status: 'success',
      providerId: job.providerId,
      model: job.modelId,
    })

    return { success: true, cronjob: updated }
  } catch (err) {
    const finishedAt = Date.now()
    const message = err instanceof Error ? err.message : 'Cronjob execution failed'
    const lastResult: CronjobRunResult = {
      status: 'error',
      error: message,
      finishedAt,
      durationMs: finishedAt - startedAt,
    }
    const updated: CronjobTask = {
      ...job,
      lastRunAt: startedAt,
      lastResult,
      updatedAt: finishedAt,
    }
    updated.nextRunAt = computeNextRunAtForJob(updated, finishedAt)
    replaceCronjob(storage, updated)

    if (chatCtx) {
      await chatCtx.persistDone.catch(() => {})
      persistCronjobRun(storage, {
        chatId: chatCtx.chatId,
        jobId: job.id,
        timestamp: startedAt,
        title: toHistoryTitle(`Error: ${message}`, 'Error'),
        status: 'error',
        providerId: job.providerId,
        model: job.modelId,
      })
    } else {
      persistCronjobRun(storage, {
        jobId: job.id,
        timestamp: startedAt,
        title: toHistoryTitle(`Error: ${message}`, 'Error'),
        status: 'error',
        providerId: job.providerId,
        model: job.modelId,
      })
    }

    return { success: false, cronjob: updated, error: message }
  } finally {
    chatCtx?.finish()
    if (chatCtx) {
      await getSessionManager().destroy(chatCtx.chatId)
    }
  }
}
