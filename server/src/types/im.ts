export type IMSource = 'slack' | 'telegram' | 'discord' | string

export type IMProviderMode = 'interactive' | 'mate'

export type IMChannelKind = 'channel' | 'dm'

export type IMSenderKind = 'human' | 'external_bot' | 'self_bot'

export interface IMProviderRecord {
  id: number
  source: IMSource
  instanceId: string
  mode: IMProviderMode
  agentId: number | null
  selfUserId: string
  selfBotId: string | null
  displayName: string
  credentialsJson: string
  configJson: string | null
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface CreateIMProviderInput {
  source: IMSource
  instanceId: string
  mode: IMProviderMode
  agentId?: number | null
  selfUserId: string
  selfBotId?: string | null
  displayName: string
  credentialsJson: string
  configJson?: string | null
  enabled?: boolean
}

export interface UpdateIMProviderInput {
  instanceId?: string
  agentId?: number | null
  selfUserId?: string
  selfBotId?: string | null
  displayName?: string
  credentialsJson?: string
  configJson?: string | null
  enabled?: boolean
}

export interface IMMessageRow {
  id: number
  recipientAgentId: number | null
  source: IMSource
  sourceChannel: string
  sourceTs: string
  senderKind: IMSenderKind
  senderId: string
  senderName: string
  senderAgentId: number | null
  text: string
  threadRef: string | null
  replyToRef: string | null
  attachmentsJson: string | null
  rawJson: string | null
  receivedAt: number
}

export interface CreateIMMessageInput {
  recipientAgentId: number
  source: IMSource
  sourceChannel: string
  sourceTs: string
  senderKind: IMSenderKind
  senderId: string
  senderName: string
  senderAgentId?: number | null
  text: string
  threadRef?: string | null
  replyToRef?: string | null
  attachmentsJson?: string | null
  rawJson?: string | null
}

export interface IMInsertResult {
  inserted: boolean
  row: IMMessageRow
}

export interface IMInteractiveChat {
  source: IMSource
  externalId: string
  chatId: number
  createdAt: number
  updatedAt: number
}

export interface UpsertIMInteractiveChatInput {
  source: IMSource
  externalId: string
  chatId: number
}

export interface IMCredentialField {
  /** Key under credentialsJson (e.g. "botToken") */
  key: string
  label: string
  /** Mask in UI + never echo in logs */
  secret: boolean
  required: boolean
  placeholder?: string
  helpText?: string
}

export interface IMSourceMeta {
  source: IMSource
  label: string
  /** Lucide icon name used on the frontend (e.g. "Hash", "Send"). */
  icon: string
  credentialFields: IMCredentialField[]
  /** Modes this source supports. Defaults to ['mate', 'interactive']. */
  supportedModes?: IMProviderMode[]
}
