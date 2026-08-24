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

export interface IMProviderCreateInput {
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

export interface IMProviderUpdateInput {
  instanceId?: string
  agentId?: number | null
  selfUserId?: string
  selfBotId?: string | null
  displayName?: string
  credentialsJson?: string
  configJson?: string | null
  enabled?: boolean
}

export interface IMChannelBinding {
  id: number
  source: IMSource
  sourceChannel: string
  sourceChannelName: string | null
  channelKind: IMChannelKind
  agentId: number
  providerId: number
  createdAt: number
}

export interface IMCredentialField {
  key: string
  label: string
  secret: boolean
  required: boolean
  placeholder?: string
  helpText?: string
}

export interface IMSourceMeta {
  source: IMSource
  label: string
  icon: string
  credentialFields: IMCredentialField[]
  supportedModes?: IMProviderMode[]
}

export interface IMMessageRecord {
  id: number
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
