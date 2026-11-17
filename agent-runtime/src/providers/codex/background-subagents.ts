import type { RuntimeBackgroundTask } from '../../types.js'
import type { AppServerClient } from './sdk/app-server-client.js'

/**
 * Codex (0.16x+) reports a spawned sub-agent on the parent thread as a
 * `subAgentActivity` item: `started` when it is spawned, `completed` /
 * `interrupted` when it ends — the end often long after the parent's turn is
 * over. The sub-agent itself runs on a thread of its own (`agentThreadId`).
 */
export interface SubAgentActivityItem {
  type: 'subAgentActivity'
  id: string
  kind: 'started' | 'interacted' | 'interrupted' | 'completed'
  agentThreadId: string
  agentPath: string
  model?: string | null
  startedAtMs?: number
  completedAtMs?: number
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isSubAgentActivity(item: unknown): item is SubAgentActivityItem {
  return isRecord(item) && item.type === 'subAgentActivity' && typeof item.id === 'string' && typeof item.agentThreadId === 'string'
}

/** `/root/run_sleep_ls` → `run sleep ls`: the name the model gave the agent, as a title. */
export function subAgentName(agentPath: string): string {
  const leaf = agentPath.split('/').filter(Boolean).at(-1) ?? 'agent'
  return leaf.replace(/[_-]+/g, ' ').trim() || 'agent'
}

/** The tool a sub-agent step is drawn as, by Codex item type. */
function stepToolName(item: JsonRecord): string | undefined {
  switch (String(item.type).toLowerCase()) {
    case 'commandexecution':
      return 'Bash'
    case 'filechange':
      return 'Edit'
    case 'mcptoolcall':
      return typeof item.tool === 'string' ? item.tool : 'mcp'
    case 'websearch':
      return 'WebSearch'
    case 'dynamictoolcall':
      return typeof item.tool === 'string' ? item.tool : 'tool'
    default:
      return undefined
  }
}

interface TrackedTask extends RuntimeBackgroundTask {
  /** The sub-agent thread's turn in progress, to interrupt it. */
  activeTurnId?: string
}

/**
 * The sub-agents a Codex session spawned, read off the shared app-server
 * connection for as long as the session lives — not per turn, since a
 * sub-agent routinely outlives the turn that spawned it. Its card reads its
 * status from this list (`toolUseId` is the parent's `subAgentActivity` item).
 */
export class CodexBackgroundSubagents {
  private readonly tasks = new Map<string, TrackedTask>()

  constructor(
    private readonly isOwnThread: (threadId: unknown) => boolean,
    private readonly onChange: (tasks: RuntimeBackgroundTask[]) => void,
  ) {}

  /** Listen on `client`; returns the unsubscribers. */
  attach(client: AppServerClient): Array<() => void> {
    return [
      client.onNotification('item/started', (params) => this.handleItem(params, 'started')),
      client.onNotification('item/completed', (params) => this.handleItem(params, 'completed')),
      client.onNotification('turn/started', (params) => {
        if (!isRecord(params) || typeof params.threadId !== 'string' || !isRecord(params.turn)) return
        const task = this.tasks.get(params.threadId)
        if (task && typeof params.turn.id === 'string') task.activeTurnId = params.turn.id
      }),
    ]
  }

  list(): RuntimeBackgroundTask[] {
    return [...this.tasks.values()].map(({ activeTurnId: _turn, ...task }) => task)
  }

  has(taskId: string): boolean {
    return this.tasks.has(taskId)
  }

  activeTurn(taskId: string): string | undefined {
    return this.tasks.get(taskId)?.activeTurnId
  }

  clearFinished(): void {
    let changed = false
    for (const [id, task] of this.tasks) {
      if (task.status === 'running') continue
      this.tasks.delete(id)
      changed = true
    }
    if (changed) this.emit()
  }

  private handleItem(params: unknown, phase: 'started' | 'completed'): void {
    if (!isRecord(params) || !isRecord(params.item)) return
    const item = params.item
    if (this.isOwnThread(params.threadId)) {
      // Each activity arrives as a started/completed pair; one is enough.
      if (phase !== 'completed' || !isSubAgentActivity(item)) return
      this.activity(item)
      return
    }
    const task = typeof params.threadId === 'string' ? this.tasks.get(params.threadId) : undefined
    if (!task || task.status !== 'running' || phase !== 'started') return
    const toolName = stepToolName(item)
    if (!toolName) return
    task.toolUses = (task.toolUses ?? 0) + 1
    task.lastToolName = toolName
    this.emit()
  }

  private activity(item: SubAgentActivityItem): void {
    const existing = this.tasks.get(item.agentThreadId)
    if (item.kind === 'started') {
      if (existing) return
      this.tasks.set(item.agentThreadId, {
        taskId: item.agentThreadId,
        toolUseId: item.id,
        taskType: 'subagent',
        backgrounded: true,
        description: subAgentName(item.agentPath),
        status: 'running',
        toolUses: 0,
        startedAt: item.startedAtMs ?? Date.now(),
      })
      this.emit()
      return
    }
    if (!existing || existing.status !== 'running') return
    if (item.kind === 'completed' || item.kind === 'interrupted') {
      existing.status = item.kind === 'completed' ? 'completed' : 'stopped'
      existing.endedAt = item.completedAtMs ?? Date.now()
      existing.activeTurnId = undefined
      this.emit()
    }
  }

  private emit(): void {
    this.onChange(this.list())
  }
}

/** One tool call a sub-agent made, shaped like a tool part (see `shared/background-tasks.ts`). */
export interface CodexSubagentStep {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  state: 'input-available' | 'output-available' | 'output-error'
  output?: unknown
  errorText?: string
}

export interface CodexSubagentTranscript {
  steps: CodexSubagentStep[]
  finished: boolean
}

interface ThreadReadResult {
  thread: { status?: unknown; turns?: Array<{ items?: unknown[] }> }
}

function items(result: ThreadReadResult): JsonRecord[] {
  return (result.thread.turns ?? []).flatMap((turn) => (turn.items ?? []).filter(isRecord))
}

function stepOf(item: JsonRecord): CodexSubagentStep | undefined {
  const toolName = stepToolName(item)
  if (!toolName || typeof item.id !== 'string') return undefined
  const type = String(item.type).toLowerCase()
  const input: Record<string, unknown> =
    type === 'commandexecution' ? { command: item.command, cwd: item.cwd }
      : type === 'filechange' ? { changes: item.changes }
        : isRecord(item.arguments) ? item.arguments
          : type === 'websearch' ? { query: item.query }
            : {}
  const status = typeof item.status === 'string' ? item.status : undefined
  const failed = status === 'failed' || status === 'declined' || (typeof item.exitCode === 'number' && item.exitCode !== 0)
  const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput
    : item.result !== undefined && item.result !== null ? item.result
      : undefined
  if (status === 'inProgress' || status === undefined && output === undefined) return { toolCallId: item.id, toolName, input, state: 'input-available' }
  if (failed) {
    const error = item.error ?? output
    return { toolCallId: item.id, toolName, input, state: 'output-error', errorText: typeof error === 'string' ? error : JSON.stringify(error ?? 'Failed') }
  }
  return { toolCallId: item.id, toolName, input, state: 'output-available', ...(output !== undefined ? { output } : {}) }
}

/** A sub-agent thread's steps, from `thread/read` with its turns. */
export function codexSubagentTranscriptFrom(result: ThreadReadResult): CodexSubagentTranscript {
  const steps = items(result).flatMap((item) => stepOf(item) ?? [])
  const status = isRecord(result.thread.status) ? result.thread.status.type : result.thread.status
  const turns = result.thread.turns ?? []
  return { steps, finished: status !== 'active' && status !== 'systemError' && turns.length > 0 }
}

/**
 * The steps of the sub-agent that the parent's `subAgentActivity` item
 * `toolUseId` spawned, read from both threads' history. Null when that item is
 * not a spawn on `threadId`.
 */
export async function readCodexSubagentTranscript(
  client: AppServerClient,
  threadId: string,
  toolUseId: string,
): Promise<CodexSubagentTranscript | null> {
  const parent = await client.request<ThreadReadResult>('thread/read', { threadId, includeTurns: true })
  const spawn = items(parent).find((item) => isSubAgentActivity(item) && item.id === toolUseId)
  if (!spawn || !isSubAgentActivity(spawn)) return null
  return codexSubagentTranscriptFrom(await client.request<ThreadReadResult>('thread/read', { threadId: spawn.agentThreadId, includeTurns: true }))
}
