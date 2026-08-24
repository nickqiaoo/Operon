import type { ChannelRef, IMProvider, SendOptions } from './types.js'

/**
 * Outbound — thin wrapper around IMProvider.send.
 *
 * `im_messages` is an inbox of messages RECEIVED by a mate agent; it is not a
 * mirror of the external channel. An agent's own outbound therefore does not
 * touch the table: the platform echo (where one exists) is what populates the
 * row, and only for peer agents who actually need it in their inbox.
 */
export interface OutboundSendInput {
  provider: IMProvider
  target: string
  content: string
  opts?: SendOptions
}

export interface OutboundResult {
  sourceTs: string
  ref: ChannelRef
}

export async function outboundSend(input: OutboundSendInput): Promise<OutboundResult> {
  const { provider, target, content, opts } = input
  const ref = provider.resolveTarget(target)
  const { sourceTs } = await provider.send(ref, content, opts)
  return { sourceTs, ref }
}
