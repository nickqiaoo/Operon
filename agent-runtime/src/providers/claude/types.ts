import type {
  McpServerConfig,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

export type ClaudeThinkingLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ClaudeRuntimeSettings {
  modelId: string
  cwd: string
  permissionMode: PermissionMode
  thinkingLevel: ClaudeThinkingLevel
  fastMode: boolean
  resume?: string
  pathToClaudeCodeExecutable: string
  settingSources: Array<'user' | 'project' | 'local'>
  persistSession: boolean
  includePartialMessages: boolean
  enableFileCheckpointing: boolean
  allowDangerouslySkipPermissions: boolean
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServers?: Record<string, McpServerConfig>
  env?: Record<string, string | undefined>
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string }
  extraArgs?: Record<string, string | null>
}

export interface ToolStreamState {
  name: string
  lastSerializedInput?: string
  inputStarted: boolean
  inputClosed: boolean
  callEmitted: boolean
  parentToolCallId?: string | null
  hasAssistantSnapshot?: boolean
}

export interface PendingApproval {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  suggestions?: PermissionUpdate[]
  resolve: (decision: PermissionResult) => void
}

export interface ClaudeMappedPrompt {
  messagesPrompt: string
  systemPrompt?: string
  warnings?: string[]
  streamingContentParts: SDKUserMessage['message']['content']
  hasImageParts: boolean
}
