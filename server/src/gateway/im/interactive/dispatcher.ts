/**
 * InteractiveDispatcher — consumer for interactive-mode IMProviders.
 *
 * Replaces the legacy `Gateway`. Attached to an IMProvider via `attach()`,
 * it listens for message events, routes slash commands, and drives the
 * setup wizard / chat turn / approval flows against the unified
 * IMProvider API (ChannelRef + askChoice + createStreamWriter + ...).
 *
 * One InteractiveDispatcher instance per process; it keeps a
 * providerId → IMProvider map so approval callbacks can route back to the
 * originating provider without holding a direct reference.
 */

import { randomUUID } from 'crypto'
import type { TextStreamPart, ToolSet, UIMessage } from 'ai'
import type { SqliteStorage } from '../../../storage/sqlite.js'
import type { IMSource } from '../../../types/im.js'
import type { DiffPreviewService } from '../../diff-preview-service.js'
import type { ChannelRef, IMEvent, IMProvider } from '../types.js'
import type { InteractiveCommandContext } from '../slash-commands/types.js'
import type { SlashCommandRegistry } from '../slash-commands/registry.js'
import { consumeFullStream } from './chat-consumer.js'
import { parseCommand } from './parse-command.js'
import type { PermissionHandler } from '../permission-handler.js'
import type { SessionConfig, SessionConfigStore } from './session-config.js'
import { runSetupWizard } from './setup-wizard.js'
import { startChat } from '../../../services/ai.js'
import { readPreparedTextStreamParts } from '../../../services/ai/prepared-stream-parts.js'
import { loadInlineImages, MAX_INLINE_IMAGE_BYTES } from '../attachment-loader.js'

export interface InteractiveDispatcherDeps {
  storage: SqliteStorage
  diffPreviewService: DiffPreviewService
  permissionHandler: PermissionHandler
  sessionConfigStore: SessionConfigStore
  slashRegistry: SlashCommandRegistry
}

interface ActiveStream {
  abortController: AbortController
  chatId: number
  requestId: string
}

export class InteractiveDispatcher {
  private readonly storage: SqliteStorage
  private readonly diffPreviewService: DiffPreviewService
  private readonly sessionConfigStore: SessionConfigStore
  private readonly permissionHandler: PermissionHandler
  private readonly slashRegistry: SlashCommandRegistry
  private readonly providers = new Map<number, IMProvider>()
  private readonly activeStreams = new Map<string, ActiveStream>()

  constructor(deps: InteractiveDispatcherDeps) {
    this.storage = deps.storage
    this.diffPreviewService = deps.diffPreviewService
    this.sessionConfigStore = deps.sessionConfigStore
    this.permissionHandler = deps.permissionHandler
    this.slashRegistry = deps.slashRegistry
  }

  attach(provider: IMProvider): () => void {
    this.providers.set(provider.providerId, provider)
    const dispose = provider.onEvent((ev) => {
      this.handle(provider, ev).catch((err) => {
        console.error(
          `[Interactive:${provider.source}:${provider.instanceId}] dispatch error:`, err,
        )
      })
    })
    return () => {
      dispose()
      this.providers.delete(provider.providerId)
    }
  }

  private async handle(provider: IMProvider, ev: IMEvent): Promise<void> {
    if (ev.kind !== 'message') return
    if (!ev.text && !ev.attachments?.length) return

    const ref: ChannelRef = { sourceChannel: ev.sourceChannel, threadRef: ev.threadRef }
    const channelKey = this.channelKey(provider, ref)
    const source = provider.source
    const externalId = this.externalId(ref)

    // Incoming message cancels any pending choice in this channel.
    provider.cancelPendingChoice(ref, 'Cancelled by new message')

    const parsed = parseCommand(ev.text ?? '')
    if (parsed.isCommand) {
      // Any `/xxx` in interactive mode is swallowed — either handled by the
      // registry or silently ignored. Falling through to the chat turn would
      // attempt to start a chat with "/typo" as the prompt, which is the old
      // `switch default: return` behaviour we want to preserve.
      await this.slashRegistry.dispatch('interactive', ev.text, (commandName, args) => {
        const ctx: InteractiveCommandContext = {
          mode: 'interactive',
          provider,
          ref,
          channelKey,
          source,
          externalId,
          commandName,
          args,
        }
        return ctx
      })
      return
    }

    const mapping = this.storage.getIMInteractiveChat(source, externalId)
    if (!mapping) {
      const pending = this.sessionConfigStore.get(channelKey)
      if (!pending) {
        console.log(`[Interactive] No mapping/pending for key=${channelKey}, starting wizard`)
        await runSetupWizard(
          {
            provider,
            storage: this.storage,
            sessionConfigStore: this.sessionConfigStore,
          },
          ref,
        )
        return
      }
      await this.runChatTurn(provider, ref, channelKey, source, externalId, ev)
      return
    }

    const sessionConfig = this.resolveConfigForChat(channelKey, mapping.chatId)
    if (!sessionConfig) {
      console.log(`[Interactive] No session config for key=${channelKey}, starting wizard`)
      this.storage.deleteIMInteractiveChat(source, externalId)
      await runSetupWizard(
        {
          provider,
          storage: this.storage,
          sessionConfigStore: this.sessionConfigStore,
        },
        ref,
      )
      return
    }

    await this.runChatTurn(provider, ref, channelKey, source, externalId, ev)
  }

  private async runChatTurn(
    provider: IMProvider,
    ref: ChannelRef,
    channelKey: string,
    source: IMSource,
    externalId: string,
    ev: IMEvent,
  ): Promise<void> {
    const mapping = this.storage.getIMInteractiveChat(source, externalId)

    let sessionConfig: SessionConfig | undefined
    let startChatChatId = 0

    if (mapping) {
      sessionConfig = this.resolveConfigForChat(channelKey, mapping.chatId)
      startChatChatId = mapping.chatId
    } else {
      sessionConfig = this.sessionConfigStore.get(channelKey)
    }

    if (!sessionConfig) return

    console.log(
      `[Interactive] turn key=${channelKey} chatId=${startChatChatId} ` +
      `provider=${sessionConfig.providerId} workspace=${sessionConfig.workspaceId}`,
    )

    const parts = await this.buildUserMessageParts(provider, ev)
    if (parts.length === 0) return

    const userMessage: UIMessage = {
      id: randomUUID(),
      role: 'user',
      parts,
    }

    const { resolvedChatId } = await this.runStream(
      provider, ref, channelKey, sessionConfig, startChatChatId, [userMessage],
    )

    if (resolvedChatId > 0 && (!mapping || mapping.chatId !== resolvedChatId)) {
      this.storage.upsertIMInteractiveChat({ source, externalId, chatId: resolvedChatId })
    }
  }

  /**
   * Build the user-message UI parts for one inbound IMEvent: text first, then
   * each successfully-loaded image as a `file` part with a base64 data URL.
   * Dropped attachments degrade to placeholder text so the model still sees
   * that *something* was sent. Images persist into chat_history along with the
   * rest of the conversation (ai-sdk's standard FileUIPart shape).
   */
  private async buildUserMessageParts(
    provider: IMProvider,
    ev: IMEvent,
  ): Promise<UIMessage['parts']> {
    const parts: UIMessage['parts'] = []
    if (ev.text) parts.push({ type: 'text', text: ev.text })

    const attachments = ev.attachments ?? []
    if (attachments.length === 0) return parts

    const result = await loadInlineImages(provider, attachments, MAX_INLINE_IMAGE_BYTES)
    for (const img of result.loaded) {
      parts.push({
        type: 'file',
        mediaType: img.mimeType,
        filename: img.attachment.name,
        url: `data:${img.mimeType};base64,${img.data.toString('base64')}`,
      })
    }
    for (const d of result.dropped) {
      const name = d.attachment.name ?? d.attachment.url
      const reason =
        d.reason === 'over-budget' ? 'too large' :
        d.reason === 'fetch-failed' ? 'fetch failed' :
        d.reason === 'no-fetcher' ? 'fetch unsupported' :
        'non-image'
      parts.push({ type: 'text', text: `[image omitted: ${name} — ${reason}]` })
    }
    return parts
  }

  private async runStream(
    provider: IMProvider,
    ref: ChannelRef,
    channelKey: string,
    sessionConfig: SessionConfig,
    startChatChatId: number,
    messages: UIMessage[],
  ): Promise<{ resolvedChatId: number }> {
    const prev = this.activeStreams.get(channelKey)
    if (prev) {
      prev.abortController.abort()
      this.activeStreams.delete(channelKey)
    }

    const streamAbort = new AbortController()
    const active: ActiveStream = {
      abortController: streamAbort,
      chatId: startChatChatId,
      requestId: randomUUID(),
    }
    this.activeStreams.set(channelKey, active)

    let resolvedChatId = startChatChatId
    try {
      const ctx = await startChat({
        chatId: startChatChatId > 0 ? startChatChatId : undefined,
        messages,
        providerId: sessionConfig.providerId,
        modelId: sessionConfig.modelId,
        modeId: sessionConfig.modeId,
        workspaceId: sessionConfig.workspaceId,
        skipSnapshot: true,
      }, streamAbort.signal)
      resolvedChatId = ctx.chatId

      await consumeFullStream({
        provider,
        ref,
        channelKey,
        fullStream: readPreparedTextStreamParts(ctx.preparedParts) as AsyncIterable<TextStreamPart<ToolSet>>,
        internalChatId: ctx.chatId,
        signal: streamAbort.signal,
        permissionHandler: this.permissionHandler,
        diffPreviewService: this.diffPreviewService,
      })

      await ctx.persistDone
      ctx.finish()
    } catch (err) {
      if (!streamAbort.signal.aborted) {
        console.error('[Interactive] stream error:', err)
        const errorMsg = err instanceof Error ? err.message : 'Chat failed'
        await provider.send(ref, `❌ ${errorMsg}`).catch(() => {})
      }
    } finally {
      if (this.activeStreams.get(channelKey) === active) {
        this.activeStreams.delete(channelKey)
      }
    }

    return { resolvedChatId }
  }

  /**
   * Custom-provider permission flow. The custom runtime's resolvePermission()
   * is a no-op — approval is consumed by the *next* startChat round-trip
   * (chat-flow reads approval state off the latest assistant message). So
   * the dispatcher mutates + persists chat history first, then re-issues a
   * stream with empty messages so chat-flow finds the approval and continues.
   *
   * Public so the shared PermissionHandler (constructed in app.ts) can route
   * custom-provider approvals back into the dispatcher.
   */
  async runApprovalResponse(
    channelKey: string,
    approvalId: string,
    approved: boolean,
    reason?: string,
  ): Promise<void> {
    const providerId = parseProviderIdFromKey(channelKey)
    const provider = providerId != null ? this.providers.get(providerId) : undefined
    if (!provider) return

    const ref = parseRefFromKey(channelKey)
    if (!ref) return
    const source = provider.source
    const externalId = this.externalId(ref)

    const mapping = this.storage.getIMInteractiveChat(source, externalId)
    if (!mapping) return

    const sessionConfig = this.resolveConfigForChat(channelKey, mapping.chatId)
    if (!sessionConfig) return

    const chatEntry = this.storage.getChatEntry(mapping.chatId)
    if (!chatEntry) return
    const messages = chatEntry.messages as UIMessage[]

    let assistantIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'assistant') continue
      assistantIndex = i
      for (const part of messages[i].parts) {
        const toolPart = part as {
          type: string
          approval?: { id: string; approved?: boolean; reason?: string }
          state?: string
        }
        if (
          (toolPart.type === 'dynamic-tool' || toolPart.type?.startsWith('tool-')) &&
          toolPart.approval?.id === approvalId
        ) {
          toolPart.state = 'approval-responded'
          toolPart.approval = { id: approvalId, approved, reason }
        }
      }
      break
    }
    if (assistantIndex < 0) return

    const meta = this.storage.getChatMeta(mapping.chatId)
    if (!meta) return
    const patchResult = this.storage.patchChatEntry(mapping.chatId, {
      baseRevision: meta.revision,
      replaceFrom: assistantIndex,
      tailMessages: [messages[assistantIndex]],
      // Rewrites an existing assistant message in place rather than adding one.
      // The runStream below produces the real next turn and stamps the time
      // when it persists.
      updatedAt: meta.updatedAt,
    })
    if (!patchResult.success) {
      console.error('[Interactive] failed to patch approval response:', {
        chatId: mapping.chatId, approvalId,
      })
      return
    }

    await this.runStream(provider, ref, channelKey, sessionConfig, mapping.chatId, [])
  }

  private resolveConfigForChat(channelKey: string, chatId: number): SessionConfig | undefined {
    const cached = this.sessionConfigStore.get(channelKey)
    if (cached) return cached
    const entry = this.storage.getChatEntry(chatId)
    if (!entry?.providerId || !entry.workspaceId) return undefined
    const config: SessionConfig = {
      providerId: entry.providerId,
      modelId: entry.model,
      modeId: entry.metadata?.modeId,
      workspaceId: entry.workspaceId,
    }
    this.sessionConfigStore.set(channelKey, config)
    return config
  }

  private channelKey(provider: IMProvider, ref: ChannelRef): string {
    return `${provider.providerId}:${ref.sourceChannel}:${ref.threadRef ?? '0'}`
  }

  private externalId(ref: ChannelRef): string {
    return `${ref.sourceChannel}:${ref.threadRef ?? '0'}`
  }
}

function parseProviderIdFromKey(channelKey: string): number | undefined {
  const idx = channelKey.indexOf(':')
  if (idx < 0) return undefined
  const id = Number.parseInt(channelKey.slice(0, idx), 10)
  return Number.isFinite(id) ? id : undefined
}

function parseRefFromKey(channelKey: string): ChannelRef | undefined {
  const parts = channelKey.split(':')
  if (parts.length < 2) return undefined
  const sourceChannel = parts[1]
  const threadRef = parts[2] && parts[2] !== '0' ? parts[2] : undefined
  return { sourceChannel, threadRef }
}
