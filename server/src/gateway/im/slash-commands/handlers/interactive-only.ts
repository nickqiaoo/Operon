import { runSetupWizard } from '../../interactive/setup-wizard.js'
import type { Choice } from '../../types.js'
import type { SlashCommand } from '../types.js'

const HELP_TEXT =
  `Send any message to chat with AI.\n\n` +
  `**Commands:**\n` +
  `/start - Start setup or show commands\n` +
  `/help - Show this help message\n` +
  `/model - Switch model\n` +
  `/mode - Switch mode\n` +
  `/continue - Continue an existing chat\n` +
  `/stop - Stop generation\n` +
  `/status - Session info\n` +
  `/new - Reconfigure this session`

export const startCommand: SlashCommand = {
  name: 'start',
  description: 'Start setup or show commands',
  modes: ['interactive'],
  async handler(ctx, deps) {
    if (ctx.mode !== 'interactive') return
    const mapping = deps.storage.getIMInteractiveChat(ctx.source, ctx.externalId)
    if (mapping) {
      await ctx.provider.send(ctx.ref, HELP_TEXT)
      return
    }
    await runSetupWizard(
      {
        provider: ctx.provider,
        storage: deps.storage,
        sessionConfigStore: deps.sessionConfigStore,
      },
      ctx.ref,
    )
  },
}

export const helpCommand: SlashCommand = {
  name: 'help',
  description: 'Show this help message',
  modes: ['interactive'],
  async handler(ctx) {
    if (ctx.mode !== 'interactive') return
    await ctx.provider.send(ctx.ref, HELP_TEXT)
  },
}

export const newCommand: SlashCommand = {
  name: 'new',
  description: 'Reconfigure this session',
  modes: ['interactive'],
  async handler(ctx, deps) {
    if (ctx.mode !== 'interactive') return
    const existing = deps.storage.getIMInteractiveChat(ctx.source, ctx.externalId)
    if (existing) {
      await deps.sessionManager.destroy(existing.chatId).catch(() => {})
      deps.storage.deleteIMInteractiveChat(ctx.source, ctx.externalId)
    }
    deps.sessionConfigStore.delete(ctx.channelKey)
    await runSetupWizard(
      {
        provider: ctx.provider,
        storage: deps.storage,
        sessionConfigStore: deps.sessionConfigStore,
      },
      ctx.ref,
    )
  },
}

export const continueCommand: SlashCommand = {
  name: 'continue',
  description: 'Continue an existing chat',
  modes: ['interactive'],
  async handler(ctx, deps) {
    if (ctx.mode !== 'interactive') return
    const { provider } = ctx
    const sessionConfig = deps.sessionConfigStore.get(ctx.channelKey)
    if (!sessionConfig) {
      await provider.sendPlain(ctx.ref, 'No session yet. Use /start to set up first.')
      return
    }
    try {
      const recentChats = deps.storage
        .listChatEntries({ workspaceId: sessionConfig.workspaceId, tp: 'chat' })
        .slice(0, 10)
      if (recentChats.length === 0) {
        await provider.sendPlain(ctx.ref, 'No chat history found.')
        return
      }
      const choices: Choice[] = recentChats.map((c) => ({
        id: String(c.id),
        label: c.title.length > 40 ? c.title.slice(0, 37) + '...' : c.title,
      }))
      const selectedIdStr = await provider.askChoice(ctx.ref, 'Select a chat to continue:', choices)
      const selectedChatId = parseInt(selectedIdStr, 10)
      const chatEntry = deps.storage.getChatEntry(selectedChatId)
      if (!chatEntry) {
        await provider.send(ctx.ref, '❌ Chat not found.')
        return
      }
      deps.storage.upsertIMInteractiveChat({
        source: ctx.source,
        externalId: ctx.externalId,
        chatId: selectedChatId,
      })
      if (chatEntry.providerId && chatEntry.workspaceId) {
        deps.sessionConfigStore.set(ctx.channelKey, {
          providerId: chatEntry.providerId,
          modelId: chatEntry.model,
          modeId: chatEntry.metadata?.modeId,
          workspaceId: chatEntry.workspaceId,
        })
      }
      await deps.sessionManager.destroy(selectedChatId).catch(() => {})
      const title = chatEntry.title || 'Chat'
      const msgCount = chatEntry.messages.length
      await provider.send(ctx.ref, `✅ Continuing: ${title} (${msgCount} messages)`)
    } catch (err) {
      await provider.sendPlain(
        ctx.ref,
        `Failed: ${err instanceof Error ? err.message : 'Unknown'}`,
      )
    }
  },
}

export const statusCommand: SlashCommand = {
  name: 'status',
  description: 'Session info',
  modes: ['interactive'],
  async handler(ctx, deps) {
    if (ctx.mode !== 'interactive') return
    const { provider } = ctx
    const sessionConfig = deps.sessionConfigStore.get(ctx.channelKey)
    if (!sessionConfig) {
      await provider.sendPlain(ctx.ref, 'No session yet. Send a message to set up.')
      return
    }
    const mapping = deps.storage.getIMInteractiveChat(ctx.source, ctx.externalId)
    const session = mapping ? deps.sessionManager.get(mapping.chatId) : null
    const isActive = session?.activeRequest != null
    await provider.send(
      ctx.ref,
      `**Session Status**\n\n` +
        `**Provider**: ${sessionConfig.providerId}\n` +
        `**Model**: ${sessionConfig.modelId || 'default'}\n` +
        `**Mode**: ${sessionConfig.modeId || 'default'}\n` +
        `**Active**: ${isActive ? 'Yes' : 'No'}`,
    )
  },
}
