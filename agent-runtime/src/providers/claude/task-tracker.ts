import type {
  SDKBackgroundTasksChangedMessage,
  SDKMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { open } from 'node:fs/promises'
import type { RuntimeBackgroundTask } from '../../types.js'

type SDKTaskMessage =
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKTaskUpdatedMessage
  | SDKTaskNotificationMessage
  | SDKBackgroundTasksChangedMessage

const TASK_SUBTYPES = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed'])

export function isTaskMessage(message: SDKMessage): message is SDKTaskMessage {
  return message.type === 'system' && TASK_SUBTYPES.has(message.subtype)
}

/** Finished tasks kept for the UI; the oldest are dropped past this. */
const MAX_SETTLED_TASKS = 50
/** Commands remembered by tool call, waiting for the task that call may start. */
const MAX_COMMANDS = 200
/** How much of a task's output `output()` returns: the end, where a running command is. */
const OUTPUT_TAIL_BYTES = 64 * 1024
/** "…Output is being written to: /tmp/…/tasks/<id>.output" in a background Bash call's result. */
const OUTPUT_FILE_NOTICE = /Output is being written to:\s*(\S+\.output)\b/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** A tool result's text, whether the CLI sent it as a string or as blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** Set, dropping the oldest entry once the map is past `MAX_COMMANDS`. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.set(key, value)
  if (map.size <= MAX_COMMANDS) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

async function readTail(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const start = Math.max(0, size - OUTPUT_TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    await file.read(buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8')
    // A cut mid-file starts mid-line; drop that partial line.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    await file.close()
  }
}

/**
 * Claude Code's task list for one session, kept current from the CLI's
 * `task_*` and `background_tasks_changed` messages and reported whole on every
 * change.
 *
 * The CLI names a task by the description the model wrote ("Run the tests"), so
 * the command line is taken from the Bash call that started it. A background
 * command writes its output to a file the CLI names; a foreground one has none
 * (`output_file` is empty), so its tool result is kept instead.
 */
export class ClaudeTaskTracker {
  private readonly tasks = new Map<string, RuntimeBackgroundTask>()
  private readonly outputFiles = new Map<string, string>()
  private readonly results = new Map<string, string>()
  /** What a tool call carried, kept until the task it may start shows up. */
  private readonly commandsByToolUse = new Map<string, string>()
  private readonly outputFilesByToolUse = new Map<string, string>()
  /** When each tool call was issued: a foreground command is only registered a few seconds in. */
  private readonly callTimes = new Map<string, number>()

  constructor(private readonly onChange: (tasks: RuntimeBackgroundTask[]) => void) {}

  list(): RuntimeBackgroundTask[] {
    return [...this.tasks.values()]
  }

  /**
   * Read what a task's tool calls carry: the command a Bash call runs (for the
   * task it may start), and the result a foreground command returns. Called for
   * every message; never consumes one.
   */
  observeToolBlocks(message: SDKMessage): void {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type !== 'tool_use' || !isRecord(block.input)) continue
        remember(this.callTimes, block.id, Date.now())
        const command = block.input.command
        if (typeof command !== 'string' || !command.trim()) continue
        remember(this.commandsByToolUse, block.id, command.trim())
      }
      return
    }
    if (message.type !== 'user' || !Array.isArray(message.message.content)) return
    for (const block of message.message.content) {
      if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const text = toolResultText(block.content)
      // A backgrounded call returns at once with a notice naming the file its
      // output goes to — the only place the path shows up before the task ends.
      // It can land before the task's `task_started`, so it is kept by call too.
      const file = OUTPUT_FILE_NOTICE.exec(text)?.[1]
      if (file) remember(this.outputFilesByToolUse, block.tool_use_id, file)
      const task = this.findByToolUse(block.tool_use_id)
      if (!task) continue
      if (file) this.outputFiles.set(task.taskId, file)
      else if (!task.backgrounded) this.results.set(task.taskId, text)
    }
  }

  handle(message: SDKTaskMessage): void {
    if (message.subtype === 'background_tasks_changed') {
      this.handleLevel(message)
      return
    }
    const now = Date.now()
    const existing = this.tasks.get(message.task_id)
    let next: RuntimeBackgroundTask | undefined

    switch (message.subtype) {
      case 'task_started': {
        if (message.skip_transcript || message.ambient) return
        const toolUseId = message.tool_use_id ?? existing?.toolUseId
        const command = toolUseId ? this.commandsByToolUse.get(toolUseId) : undefined
        const file = toolUseId ? this.outputFilesByToolUse.get(toolUseId) : undefined
        if (file) this.outputFiles.set(message.task_id, file)
        next = {
          ...existing,
          taskId: message.task_id,
          taskType: message.task_type ?? existing?.taskType ?? 'unknown',
          backgrounded: message.is_backgrounded ?? existing?.backgrounded ?? true,
          description: message.description || existing?.description || '',
          status: 'running',
          startedAt: existing?.startedAt ?? (toolUseId ? this.callTimes.get(toolUseId) : undefined) ?? now,
          ...(toolUseId ? { toolUseId } : {}),
          ...(command ? { command } : {}),
        }
        break
      }
      case 'task_updated': {
        if (!existing) return
        const { description, is_backgrounded } = message.patch
        if (description === undefined && is_backgrounded === undefined) return
        next = {
          ...existing,
          ...(description ? { description } : {}),
          ...(is_backgrounded !== undefined ? { backgrounded: is_backgrounded } : {}),
        }
        break
      }
      case 'task_progress': {
        if (!existing) return
        next = {
          ...existing,
          toolUses: message.usage.tool_uses,
          lastToolName: message.last_tool_name ?? existing.lastToolName,
          summary: message.summary ?? existing.summary,
        }
        break
      }
      case 'task_notification': {
        if (!existing) return
        if (message.output_file) this.outputFiles.set(message.task_id, message.output_file)
        next = {
          ...existing,
          status: message.status,
          summary: message.summary || existing.summary,
          toolUses: message.usage?.tool_uses ?? existing.toolUses,
          endedAt: now,
        }
        break
      }
    }
    if (!next) return
    this.put(next)
  }

  /**
   * The CLI's full list of live background tasks. A task that starts in the
   * background joins it before its `task_started`, and one the process had
   * before a reconnect is only ever seen here — so unknown entries are added.
   * Known ones are left alone: the edge messages carry more, and the order of
   * the two streams is not promised.
   */
  private handleLevel(message: SDKBackgroundTasksChangedMessage): void {
    let changed = false
    for (const entry of message.tasks) {
      if (entry.ambient || this.tasks.has(entry.task_id)) continue
      this.tasks.set(entry.task_id, {
        taskId: entry.task_id,
        taskType: entry.task_type,
        backgrounded: true,
        description: entry.description,
        status: 'running',
        startedAt: Date.now(),
      })
      changed = true
    }
    if (changed) this.emit()
  }

  async output(taskId: string): Promise<string | null> {
    const file = this.outputFiles.get(taskId)
    if (file) {
      try {
        return await readTail(file)
      } catch (error) {
        // The CLI clears its temp directory when the session ends.
        if (isRecord(error) && error.code === 'ENOENT') return null
        throw error
      }
    }
    return this.results.get(taskId) ?? null
  }

  clearFinished(): void {
    let changed = false
    for (const task of this.tasks.values()) {
      if (task.status === 'running') continue
      this.forget(task.taskId)
      changed = true
    }
    if (changed) this.emit()
  }

  private findByToolUse(toolUseId: string): RuntimeBackgroundTask | undefined {
    for (const task of this.tasks.values()) if (task.toolUseId === toolUseId) return task
    return undefined
  }

  private put(task: RuntimeBackgroundTask): void {
    this.tasks.set(task.taskId, task)
    const settled = this.list().filter((t) => t.status !== 'running')
    for (const old of settled.slice(0, Math.max(0, settled.length - MAX_SETTLED_TASKS))) this.forget(old.taskId)
    this.emit()
  }

  private forget(taskId: string): void {
    this.tasks.delete(taskId)
    this.outputFiles.delete(taskId)
    this.results.delete(taskId)
  }

  private emit(): void {
    this.onChange(this.list())
  }
}
