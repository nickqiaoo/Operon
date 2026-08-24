import type { SlashCommand } from '../types.js'

export const stopCommand: SlashCommand = {
  name: 'stop',
  description: 'Stop generation',
  modes: ['mate', 'interactive'],
  async handler(ctx, deps) {
    if (ctx.mode === 'mate') {
      deps.mateHooks.interrupt({
        bindingId: ctx.bindingId,
        agentId: ctx.agentId,
        reason: 'stop_command',
        text: ctx.triggerMessage.text,
        message: ctx.triggerMessage,
      })
      await ctx.provider.sendPlain(ctx.ref, '⏹ Stopped.')
      return
    }

    // interactive
    const mapping = deps.storage.getIMInteractiveChat(ctx.source, ctx.externalId)
    if (!mapping) {
      await ctx.provider.sendPlain(ctx.ref, 'Nothing running.')
      return
    }
    const session = deps.sessionManager.get(mapping.chatId)
    if (session?.activeRequest) {
      session.activeRequest.abortController.abort()
      session.runtime.abort()
      await ctx.provider.sendPlain(ctx.ref, '⏹ Generation stopped.')
    } else {
      await ctx.provider.sendPlain(ctx.ref, 'Nothing running.')
    }
  },
}
