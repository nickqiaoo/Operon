import type { RuntimeForkSource } from '../../types.js'

export type OpencodeMcpServerEntry =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }

export interface OpencodeLogger {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
  debug?: (message: string) => void
}

export interface OpencodeSettings {
  sessionId?: string
  /** Set for a side chat: branch off this session instead of creating a fresh one. */
  forkFrom?: RuntimeForkSource
  createNewSession?: boolean
  sessionTitle?: string
  agent?: string
  systemPrompt?: string
  tools?: Record<string, boolean>
  mcpServers?: Record<string, OpencodeMcpServerEntry>
  cwd?: string
  env?: Record<string, string | undefined>
  logger?: OpencodeLogger | false
  verbose?: boolean
}

export interface OpencodeProviderSettings {
  hostname?: string
  port?: number
  baseUrl?: string
  autoStartServer?: boolean
  serverTimeout?: number
  defaultSettings?: OpencodeSettings
}

export interface ParsedModelId {
  providerID: string
  modelID: string
}

export interface StreamingUsage {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cachedInputTokens: number
  cachedWriteTokens: number
  totalCost: number
}

export interface ToolStreamState {
  callId: string
  toolName: string
  inputStarted: boolean
  inputClosed: boolean
  callEmitted: boolean
  resultEmitted: boolean
  lastInput?: string
}

export interface ProviderListModel {
  id?: string
  name?: string
  status?: string
}

export interface ProviderListItem {
  id: string
  name: string
  models?: Record<string, ProviderListModel>
}

export interface ProviderListResponse {
  data?: {
    all?: ProviderListItem[]
    connected?: string[]
  }
}

export interface SkillListResponse {
  data?: Array<{ name: string; description: string }>
}

export interface PermissionRequestInfo {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: {
    messageID: string
    callID: string
  }
}

export interface QuestionOptionInfo {
  label: string
  description: string
}

export interface QuestionRequestInfo {
  id: string
  sessionID: string
  questions: Array<{
    question: string
    header: string
    options: QuestionOptionInfo[]
    multiSelect?: boolean
    custom?: boolean
  }>
  tool?: {
    messageID: string
    callID: string
  }
}

export type OpencodePartInput =
  | {
      id?: string
      type: 'text'
      text: string
      synthetic?: boolean
      ignored?: boolean
    }
  | {
      id?: string
      type: 'file'
      mime: string
      filename?: string
      url: string
    }
