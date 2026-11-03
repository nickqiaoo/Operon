/**
 * One entry of a Claude Code session's task list — a command that ran for more
 * than a few seconds, a sub-agent, a workflow, a monitor — carried per chat on
 * the live-status stream (`GET /api/ai/chat/live-status`). Mirrors the runtime's
 * `RuntimeBackgroundTask`. A background `Agent`'s card finds its entry by
 * `toolUseId`, the spawning tool call.
 */
export interface BackgroundTaskSummary {
  taskId: string
  /** The tool call that started it, when one did. */
  toolUseId?: string
  /** Claude Code's task kind: `local_bash`, `local_agent`, `local_workflow`, `monitor`, `mcp_task`… */
  taskType: string
  /** Running apart from the turn (launched in the background, or moved there). */
  backgrounded: boolean
  description: string
  /** The command line, for tasks a shell command started. */
  command?: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  /** Tool calls made so far. */
  toolUses?: number
  lastToolName?: string
  /** A one-line progress summary while running; the final report once finished. */
  summary?: string
  startedAt: number
  endedAt?: number
}

/**
 * One tool call a sub-agent made, read back from its transcript
 * (`GET /api/ai/chat/:chatId/subagent/:toolUseId`). Shaped like a tool part so a
 * sub-agent card renders it the same way as a step streamed in a live turn.
 */
export interface SubagentStep {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  state: 'input-available' | 'output-available' | 'output-error'
  output?: unknown
  errorText?: string
}

export interface SubagentTranscript {
  steps: SubagentStep[]
  /** The sub-agent has written its final report. */
  finished: boolean
}
