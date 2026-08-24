import type { ModelMessage, StreamTextResult } from 'ai'

// ---- Basic Types ----

export interface Model {
  id: string
  name: string
  description?: string
  /** The underlying API provider ID, e.g. "anthropic", "google" */
  providerId?: string
  /** Human-readable provider label, e.g. "Anthropic", "Google" */
  providerLabel?: string
  /** Logo key understood by the frontend, e.g. "anthropic", "google" */
  providerLogo?: string
}

export interface Mode {
  id: string
  name: string
  description?: string
}

export interface ThinkingLevel {
  id: string
  name: string
}

export type ServiceTier = 'fast'

export interface ServiceTierOption {
  id: ServiceTier
  name: string
  description?: string
}

export interface Command {
  id: string
  name: string
  description?: string
  args?: CommandArg[]
}

export interface CommandArg {
  name: string
  required: boolean
  description?: string
}

// ---- Skills ----

export interface ProviderSkill {
  name: string
  description: string
}

// ---- Slash Commands (unified skills + commands) ----

export interface SlashCommandItem {
  name: string
  description: string
  type: 'skill' | 'command'
}

// ---- ProviderDescriptor ----

export interface ProviderFeatures {
  permissions: boolean
  attachments: boolean
  injection: boolean
  sessionResume: boolean
  checkpoint?: boolean
}

export interface ProviderDescriptor {
  id: string
  label: string
  logo: string

  models: Model[]
  modes: Mode[]
  thinkingLevels?: ThinkingLevel[]
  serviceTiers?: ServiceTierOption[]
  commands: Command[]
  skills?: ProviderSkill[]
  slashCommands?: SlashCommandItem[]

  currentModelId: string
  currentModeId: string
  currentThinkingLevel?: string
  currentServiceTier?: ServiceTier

  features: ProviderFeatures
}

// ---- ProviderAdapter ----

export interface ChatParams {
  messages: ModelMessage[]
  cwd: string
  modelId?: string
  providerId?: string
  modeId?: string
  thinkingLevel?: string
  serviceTier?: ServiceTier
  sessionId?: string
  signal?: AbortSignal
}

export type PermissionDecision =
  | { type: 'allow'; updatedInput?: Record<string, unknown> }
  | { type: 'deny'; reason?: string }
  | { type: 'allow-always'; updatedInput?: Record<string, unknown> }

export interface CommandResult {
  success: boolean
  message?: string
  stateChanged?: boolean
}

export type OnModelsUpdated = (providerId: string) => void

export interface ProviderAdapter {
  getDescriptor(): Promise<ProviderDescriptor>

  // ---- Lifecycle ----
  dispose(): Promise<void>

  // ---- Chat ----
  chat(params: ChatParams): StreamTextResult<any, any> | Promise<StreamTextResult<any, any>>
  abort(): void

  // ---- Session resume ----
  getSessionId?(): string | undefined
  injectMessage?(content: string): Promise<void>

  // ---- Permissions ----
  resolvePermission(approvalId: string, decision: PermissionDecision): void

  // ---- Commands (optional, used by custom adapter) ----
  executeCommand?(commandId: string, args?: Record<string, string>): Promise<CommandResult>
}

// ---- Session ----

export interface ActiveRequest {
  requestId: string
  abortController: AbortController
}

export interface Session {
  chatId: number
  adapter: ProviderAdapter
  providerId: string
  createdAt: number
  activeRequest: ActiveRequest | null
}
