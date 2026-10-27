import type {
  McpServerConfig,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
} from '@qoder-ai/qoder-agent-sdk'
import type { RuntimeForkSource } from '../../types.js'

/** Reasoning effort, as `--reasoning-effort` takes it. Each model lists the ones it supports. */
export type QoderEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * The modes operon offers. `plan` is not a Qoder permission mode: Qoder keeps
 * Plan Mode as a separate switch on top of the permission mode, so `plan` here
 * means "Plan Mode on, permissions as `default`".
 */
export type QoderMode = Exclude<PermissionMode, 'yolo'>

export interface QoderRuntimeSettings {
  /** Empty = the account's default model, as the CLI picks it. */
  modelId: string
  cwd: string
  mode: QoderMode
  effort: QoderEffort
  resume?: string
  /** Set for a side chat: branch off this session instead of starting a new one. */
  forkFrom?: RuntimeForkSource
  /** Outside `cwd`, treated as part of it (`SessionOptions.writableDirs`). */
  additionalDirectories?: string[]
  pathToQoderCLIExecutable: string
  allowedTools: string[]
  mcpServers?: Record<string, McpServerConfig>
  env: Record<string, string | undefined>
  systemPrompt?: { type: 'preset'; preset: 'qodercli'; append?: string }
}

export interface QoderPendingApproval {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  suggestions?: PermissionUpdate[]
  /** Set for an `mcp_call`: turns the inner tool's arguments back into its input. */
  wrapInput?: (args: Record<string, unknown>) => Record<string, unknown>
  resolve: (decision: PermissionResult) => void
}
