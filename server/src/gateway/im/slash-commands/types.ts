import type { SessionManager } from '@operon/agent-runtime'
import type { SqliteStorage } from '../../../storage/sqlite.js'
import type { Agent } from '../../../types/channel.js'
import type { IMMessageRow, IMSource } from '../../../types/im.js'
import type { SessionConfigStore } from '../interactive/session-config.js'
import type { ChannelRef, IMProvider } from '../types.js'

export type SlashCommandMode = 'mate' | 'interactive'

export interface MateCommandContext {
  mode: 'mate'
  provider: IMProvider
  ref: ChannelRef
  source: IMSource
  sourceChannel: string
  agentId: number
  agent: Agent
  bindingId: number
  workspaceId: number
  triggerMessage: IMMessageRow
  commandName: string
  args: string | undefined
}

export interface InteractiveCommandContext {
  mode: 'interactive'
  provider: IMProvider
  ref: ChannelRef
  channelKey: string
  source: IMSource
  externalId: string
  commandName: string
  args: string | undefined
}

export type SlashCommandContext = MateCommandContext | InteractiveCommandContext

export interface MateHooks {
  interrupt: (params: {
    bindingId: number
    agentId: number
    reason: 'stop_command'
    text: string
    message: IMMessageRow
  }) => void
  reset: (params: {
    bindingId: number
    agentId: number
    source: IMSource
    sourceChannel: string
    message: IMMessageRow
  }) => Promise<void> | void
}

export interface SlashCommandDeps {
  storage: SqliteStorage
  sessionManager: SessionManager
  sessionConfigStore: SessionConfigStore
  mateHooks: MateHooks
}

export interface SlashCommand {
  name: string
  description: string
  modes: SlashCommandMode[]
  handler: (ctx: SlashCommandContext, deps: SlashCommandDeps) => Promise<void>
}
