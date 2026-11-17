import type { AgentEvent, HarnessSession } from 'operon-agents'
import type { RuntimeBackgroundTask } from '@operon/agent-runtime'
import type { SubagentStep, SubagentTranscript } from '../../../../shared/background-tasks.js'

type BackgroundManager = NonNullable<HarnessSession['background']>
type TaskInfo = ReturnType<BackgroundManager['list']>[number]
type AgentTaskInfo = Extract<TaskInfo, { kind: 'agent' }>
type AgentRecord = Awaited<ReturnType<HarnessSession['getRecords']>>[number]

function isAgentTask(task: Partial<TaskInfo> | undefined): task is AgentTaskInfo {
  return task?.kind === 'agent' && typeof task.taskId === 'string'
}

function runtimeStatus(status: TaskInfo['status']): RuntimeBackgroundTask['status'] {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'killed':
      return 'stopped'
    case 'failed':
    case 'timed_out':
    case 'lost':
      return 'failed'
    // `paused`: parked on an approval or question, still owed an outcome.
    default:
      return 'running'
  }
}

/** The conversation shard a background agent writes to. */
function addressOf(harness: HarnessSession, task: AgentTaskInfo): string | undefined {
  if (task.outputRef?.kind === 'conversation') return task.outputRef.address
  if (!task.agentId) return undefined
  return harness.background?.listSubagents().find((agent) => agent.agentId === task.agentId)?.address
}

/**
 * The background sub-agents an Operon session launched (`Agent` with
 * `run_in_background`), as the runtime's task list.
 *
 * Such an agent outlives the turn that launched it: the message mapper leaves
 * its steps unbound, and its card learns that it is still running, what it is
 * doing and when it ends from this list (`toolUseId` is the spawning call).
 *
 * The harness's own list only holds tasks still running — a task leaves it the
 * moment it settles — so this keeps every agent task it has seen, refreshed from
 * that list and from the started / terminated events (the latter carry the
 * final status and answer).
 */
export class OperonBackgroundSubagents {
  private readonly known = new Map<string, AgentTaskInfo>()
  /** Steps taken so far, by task id. */
  private readonly progress = new Map<string, { toolUses: number; lastToolName?: string }>()
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly harness: HarnessSession,
    private readonly onChange: (tasks: RuntimeBackgroundTask[]) => void,
  ) {}

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.harness.onEvent((event) => this.handle(event))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** The agent task the call `toolUseId` launched, running or settled. */
  taskFor(toolUseId: string): AgentTaskInfo | undefined {
    this.refresh()
    return [...this.known.values()].find((task) => task.toolCallId === toolUseId)
  }

  list(): RuntimeBackgroundTask[] {
    this.refresh()
    return [...this.known.values()].filter((task) => task.toolCallId).map((task) => {
      const progress = this.progress.get(task.taskId)
      return {
        taskId: task.taskId,
        toolUseId: task.toolCallId,
        taskType: task.subagentType ? `agent:${task.subagentType}` : 'agent',
        backgrounded: true,
        description: task.description,
        status: runtimeStatus(task.status),
        ...(progress ? { toolUses: progress.toolUses, lastToolName: progress.lastToolName } : {}),
        ...(task.result ? { summary: task.result } : {}),
        startedAt: task.startedAt,
        ...(task.endedAt != null ? { endedAt: task.endedAt } : {}),
      }
    })
  }

  /** Take in what the harness still lists (running tasks, and on a reopened session its ghosts). */
  private refresh(): void {
    for (const task of this.harness.background?.list() ?? []) {
      if (isAgentTask(task)) this.known.set(task.taskId, task)
    }
  }

  private handle(event: AgentEvent): void {
    if (event.type === 'background.task.started' || event.type === 'background.task.terminated') {
      const info = event.info as Partial<TaskInfo> | undefined
      if (!isAgentTask(info)) return
      this.known.set(info.taskId, { ...this.known.get(info.taskId), ...info })
      this.onChange(this.list())
      return
    }
    if (event.type !== 'tool.call.started' || !event.address.includes('/')) return
    const task = this.runningTaskAt(event.address)
    if (!task) return
    const progress = this.progress.get(task.taskId) ?? { toolUses: 0 }
    progress.toolUses += 1
    progress.lastToolName = event.toolName
    this.progress.set(task.taskId, progress)
    this.onChange(this.list())
  }

  /** The running background agent whose shard `address` is, or is nested under. */
  private runningTaskAt(address: string): AgentTaskInfo | undefined {
    this.refresh()
    for (const task of this.known.values()) {
      if (task.status !== 'running' && task.status !== 'paused') continue
      const own = addressOf(this.harness, task)
      if (own && (address === own || address.startsWith(`${own}/`))) return task
    }
    return undefined
  }
}

function resultText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('')
}

/** A sub-agent's tool steps, from the records of its conversation shard. */
export function operonSubagentStepsFrom(records: readonly AgentRecord[]): SubagentStep[] {
  const steps: SubagentStep[] = []
  const byId = new Map<string, SubagentStep>()
  const take = (message: Extract<AgentRecord, { type: 'context.append_message' }>['message']): void => {
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type !== 'toolCall' || byId.has(part.id)) continue
        const step: SubagentStep = { toolCallId: part.id, toolName: part.name, input: part.arguments, state: 'input-available' }
        byId.set(part.id, step)
        steps.push(step)
      }
    } else if (message.role === 'toolResult') {
      const step = byId.get(message.toolCallId)
      if (!step) return
      const text = resultText(message.content)
      if (message.isError) {
        step.state = 'output-error'
        step.errorText = text
      } else {
        step.state = 'output-available'
        step.output = text
      }
    }
  }
  for (const record of records) {
    if (record.type === 'context.append_message') take(record.message)
    else if (record.type === 'context.replace') record.messages.forEach(take)
  }
  return steps
}

/**
 * The steps of the background sub-agent that call `toolUseId` launched, read
 * from its own conversation shard. Null when the call launched no background
 * agent this session knows of.
 */
export async function readOperonSubagentTranscript(
  harness: HarnessSession,
  subagents: OperonBackgroundSubagents,
  toolUseId: string,
): Promise<SubagentTranscript | null> {
  const task = subagents.taskFor(toolUseId)
  if (!task) return null
  const address = addressOf(harness, task)
  if (!address) return null
  return {
    steps: operonSubagentStepsFrom(await harness.getRecords(address)),
    finished: task.status === 'completed',
  }
}
