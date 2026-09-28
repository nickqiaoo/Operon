/**
 * A sub-agent a conversation left running in the background (Claude Code's
 * `Agent` with `run_in_background`), carried per chat on the live-status stream
 * (`GET /api/ai/chat/live-status`). `toolUseId` is the spawning tool call — the
 * card it renders under.
 */
export interface BackgroundTaskSummary {
  taskId: string
  toolUseId: string
  description: string
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
