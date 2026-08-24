import { getProviderModels } from '../../../../services/ai.js'
import type { SqliteStorage } from '../../../../storage/sqlite.js'
import type { Choice } from '../../types.js'
import type { SlashCommand } from '../types.js'

export const modelCommand: SlashCommand = {
  name: 'model',
  description: 'Switch model',
  modes: ['mate', 'interactive'],
  async handler(ctx, deps) {
    if (ctx.mode === 'mate') {
      const { provider, agent, agentId } = ctx
      try {
        const result = await getProviderModels(agent.provider)
        if (!result.models.length) {
          await provider.sendPlain(ctx.ref, 'No models available.')
          return
        }
        const choices: Choice[] = result.models.map((m) => ({
          id: m.modelId,
          label: m.modelId === agent.model ? `✅ ${m.name}` : m.name,
        }))
        const modelId = await provider.askChoice(ctx.ref, 'Select a model:', choices)

        deps.storage.updateAgent(agentId, { model: modelId })

        // Reset the mate session so the next wake-up picks up the new model.
        deps.mateHooks.reset({
          bindingId: ctx.bindingId,
          agentId,
          source: ctx.source,
          sourceChannel: ctx.sourceChannel,
          message: ctx.triggerMessage,
        })

        await provider.send(ctx.ref, `✅ Model: ${modelId}`)
      } catch (err) {
        await provider.sendPlain(
          ctx.ref,
          `Failed: ${err instanceof Error ? err.message : 'Unknown'}`,
        )
      }
      return
    }

    // interactive
    const { provider } = ctx
    const sessionConfig = deps.sessionConfigStore.get(ctx.channelKey)
    if (!sessionConfig) {
      await provider.sendPlain(ctx.ref, 'No session yet. Send a message to set up.')
      return
    }
    try {
      const result = await getProviderModels(sessionConfig.providerId)
      if (!result.models.length) {
        await provider.sendPlain(ctx.ref, 'No models available.')
        return
      }
      const choices: Choice[] = result.models.map((m) => ({
        id: m.modelId,
        label: m.modelId === sessionConfig.modelId ? `✅ ${m.name}` : m.name,
      }))
      const modelId = await provider.askChoice(ctx.ref, 'Select a model:', choices)
      deps.sessionConfigStore.update(ctx.channelKey, { modelId })
      const mapping = deps.storage.getIMInteractiveChat(ctx.source, ctx.externalId)
      if (mapping) {
        await deps.sessionManager.destroy(mapping.chatId).catch(() => {})
        patchChatConfig(deps.storage, mapping.chatId, { model: modelId })
      }
      await provider.send(ctx.ref, `✅ Model: ${modelId}`)
    } catch (err) {
      await provider.sendPlain(
        ctx.ref,
        `Failed: ${err instanceof Error ? err.message : 'Unknown'}`,
      )
    }
  },
}

function patchChatConfig(
  storage: SqliteStorage,
  chatId: number,
  patch: { model?: string; providerId?: string; workspaceId?: number },
): void {
  const meta = storage.getChatMeta(chatId)
  if (!meta) return
  storage.patchChatEntry(chatId, {
    baseRevision: meta.revision,
    replaceFrom: -1,
    tailMessages: [],
    model: patch.model,
    providerId: patch.providerId,
    workspaceId: patch.workspaceId,
    // Config-only patch (no tailMessages): keep the existing timestamp so
    // switching model doesn't jump the chat to the top of the list or reset
    // the client's prompt-cache expiry clock.
    updatedAt: meta.updatedAt,
  })
}
