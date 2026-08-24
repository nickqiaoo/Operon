import type { SlashCommand } from '../types.js'

export const resetCommand: SlashCommand = {
  name: 'reset',
  description: 'Reset session — start a fresh chat on next message',
  modes: ['mate'],
  async handler(ctx, deps) {
    if (ctx.mode !== 'mate') return
    deps.mateHooks.reset({
      bindingId: ctx.bindingId,
      agentId: ctx.agentId,
      source: ctx.source,
      sourceChannel: ctx.sourceChannel,
      message: ctx.triggerMessage,
    })
    await ctx.provider.sendPlain(ctx.ref, '✅ Session reset.')
  },
}
