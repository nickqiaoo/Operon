import { getProviderModels } from '../../../../services/ai.js'
import type { Choice } from '../../types.js'
import type { SlashCommand } from '../types.js'

export const modeCommand: SlashCommand = {
  name: 'mode',
  description: 'Switch mode',
  modes: ['mate', 'interactive'],
  async handler(ctx, deps) {
    if (ctx.mode === 'mate') {
      const { provider, agent, agentId } = ctx
      try {
        const result = await getProviderModels(agent.provider)
        if (!result.modes.length) {
          await provider.sendPlain(ctx.ref, 'No modes available.')
          return
        }
        const choices: Choice[] = result.modes.map((m) => ({
          id: m.id,
          label: m.id === agent.permissionMode ? `✅ ${m.name}` : m.name,
        }))
        const modeId = await provider.askChoice(ctx.ref, 'Select a mode:', choices)

        deps.storage.updateAgent(agentId, { permissionMode: modeId })

        deps.mateHooks.reset({
          bindingId: ctx.bindingId,
          agentId,
          source: ctx.source,
          sourceChannel: ctx.sourceChannel,
          message: ctx.triggerMessage,
        })

        await provider.send(ctx.ref, `✅ Mode: ${modeId}`)
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
      if (!result.modes.length) {
        await provider.sendPlain(ctx.ref, 'No modes available.')
        return
      }
      const choices: Choice[] = result.modes.map((m) => ({
        id: m.id,
        label: m.id === sessionConfig.modeId ? `✅ ${m.name}` : m.name,
      }))
      const modeId = await provider.askChoice(ctx.ref, 'Select a mode:', choices)
      deps.sessionConfigStore.update(ctx.channelKey, { modeId })
      const mapping = deps.storage.getIMInteractiveChat(ctx.source, ctx.externalId)
      if (mapping) {
        await deps.sessionManager.destroy(mapping.chatId).catch(() => {})
        const existing = deps.storage.getChatMeta(mapping.chatId)
        const nextMeta = { ...(existing?.metadata ?? {}), modeId }
        deps.storage.updateChatMetadata(mapping.chatId, nextMeta)
      }
      await provider.send(ctx.ref, `✅ Mode: ${modeId}`)
    } catch (err) {
      await provider.sendPlain(
        ctx.ref,
        `Failed: ${err instanceof Error ? err.message : 'Unknown'}`,
      )
    }
  },
}
