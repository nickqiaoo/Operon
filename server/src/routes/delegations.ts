import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import type { AgentInput } from '@operon/agent-runtime'
import {
  DELEGATION_ID, DELEGATION_NODE_ID, DELEGATION_PROVIDER_ID, decodeWire, encodeWire,
  type DelegationControl, type DelegationTurnRequest,
} from '@shared/delegations'
import { DELEGATION_SOURCE_HEADER, DELEGATION_SOURCE_LABEL_HEADER, DELEGATION_TUNNEL_HEADER, REMOTE_TUNNEL_HEADER } from '@shared/e2ee/protocol'
import type { DelegationHost } from '../services/delegation-host.js'
import { DelegationHttpError, delegationRequest, listDelegationNodes } from '../services/delegation-transport.js'
import { remoteProviderModels } from '../services/remote-agent-session.js'
import { createExternalAgent } from '../services/external-agent.js'
import { trustedDelegationTunnel } from '../services/delegation-tunnel.js'
import { getChatStorage } from '../services/ai/state.js'

const sessionId = z.string().regex(DELEGATION_ID)
const nodeId = z.string().regex(DELEGATION_NODE_ID)
const providerId = z.string().regex(DELEGATION_PROVIDER_ID)
const setting = z.string().trim().min(1).max(250)
const sessionOptions = z.object({
  model: setting.optional(), mode: setting.optional(), effort: setting.optional(),
  serviceTier: z.literal('fast').optional(), resume: z.string().min(1).max(500).optional(),
})
const turnRequest = z.object({
  providerId, workspaceId: z.number().int().positive(), options: sessionOptions, input: z.unknown(),
})
const control = z.discriminatedUnion('type', [
  z.object({ type: z.literal('respond'), approvalId: z.string().min(1).max(1000), decision: z.object({ type: z.enum(['allow', 'deny', 'allow-always']) }).passthrough() }),
  z.object({ type: z.literal('abort') }),
  z.object({ type: z.literal('close') }),
  z.object({ type: z.literal('set'), patch: sessionOptions.omit({ resume: true, serviceTier: true })
    .extend({ serviceTier: z.literal('fast').nullable().optional() }) }),
  z.object({ type: z.enum(['steer', 'followup']), input: z.unknown(), id: z.string().max(200).optional() }),
])
const launch = z.object({
  providerId, model: setting, effort: setting.optional(),
  description: z.string().trim().min(1).max(300), prompt: z.string().trim().min(1).max(100_000),
  target: nodeId.optional(), workspaceId: z.number().int().positive().optional(),
})

/**
 * Features a remote agent's chat cannot use here: they read or write this
 * machine's copy of the session (goal, fork, checkpoints, context breakdown).
 */
const LOCAL_ONLY_FEATURES = ['goal', 'sideChat', 'checkpoint', 'contextUsage'] as const

export function delegationRoutes(host: DelegationHost) {
  const app = new Hono()
  app.onError((error, c) => {
    if (error instanceof DelegationHttpError) {
      return new Response(JSON.stringify({ error: error.code ?? error.message, message: error.message }), {
        status: error.status === 401 ? 403 : error.status, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid request' }, 400)
    return c.json({ error: error.message }, 500)
  })

  // ── Called by another machine of the account, through Broker ──────────────
  const source = (c: Context): { id: string; label?: string } => {
    const value = nodeId.safeParse(c.req.header(DELEGATION_SOURCE_HEADER))
    if (c.req.header(REMOTE_TUNNEL_HEADER) !== '1' || !value.success || !trustedDelegationTunnel(c.req.header(DELEGATION_TUNNEL_HEADER))) {
      throw new DelegationHttpError(403, 'Authenticated source machine required')
    }
    const encoded = c.req.header(DELEGATION_SOURCE_LABEL_HEADER)
    return { id: value.data, label: encoded ? Buffer.from(encoded, 'base64').toString('utf8') : undefined }
  }

  app.get('/catalog', async (c) => {
    source(c)
    return c.json(await host.catalog(c.req.queries('provider'), c.req.query('query'), c.req.query('models')))
  })
  app.get('/providers/:providerId/models', async (c) => {
    source(c)
    return c.json(await host.models(providerId.parse(c.req.param('providerId'))))
  })
  app.post('/sessions/:id/turn', async (c) => {
    const from = source(c)
    const id = sessionId.parse(c.req.param('id'))
    const request = turnRequest.parse(decodeWire(await c.req.text())) as DelegationTurnRequest
    const frames = host.turn(from.id, from.label, id, request, request.input as AgentInput, c.req.raw.signal)
    // Fail before the stream opens when the session cannot start, so the origin gets an HTTP error.
    const first = await frames.next()
    return streamSSE(c, async (stream) => {
      if (!first.done) await stream.writeSSE({ data: encodeWire(first.value) })
      for await (const frame of frames) await stream.writeSSE({ data: encodeWire(frame) })
    })
  })
  app.post('/sessions/:id/control', async (c) => {
    const from = source(c)
    const request = control.parse(decodeWire(await c.req.text())) as DelegationControl
    return c.json(await host.control(from.id, sessionId.parse(c.req.param('id')), request))
  })

  // ── This machine's own UI ───────────────────────────────────────────────
  const onThisMachine = (c: Context) => {
    if (c.req.header(REMOTE_TUNNEL_HEADER) === '1') throw new DelegationHttpError(403, 'Open Remote settings on this machine')
  }
  app.get('/local/settings', (c) => {
    onThisMachine(c)
    return c.json({ enabled: host.accepting(), recent: host.recent() })
  })
  app.post('/local/settings', async (c) => {
    onThisMachine(c)
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await c.req.json())
    host.setAccepting(enabled)
    return c.json({ enabled, recent: host.recent() })
  })
  app.get('/local/machines', async (c) => c.json({ machines: await listDelegationNodes() }))
  app.get('/local/machines/:nodeId/catalog', async (c) => {
    const target = nodeId.parse(c.req.param('nodeId'))
    return c.json(await delegationRequest(target, '/api/delegations/catalog?models=0'))
  })
  // What a remote agent's composer offers: the target machine's catalog for that provider.
  app.get('/local/machines/:nodeId/providers/:providerId/models', async (c) => {
    const models = await remoteProviderModels(nodeId.parse(c.req.param('nodeId')), providerId.parse(c.req.param('providerId')))
    const features = { ...models.features }
    for (const feature of LOCAL_ONLY_FEATURES) features[feature] = false
    return c.json({ ...models, features })
  })
  // The Agents panel's "Run external agent": the same call the parent's agent makes.
  app.post('/local/chats/:chatId/agents', async (c) => {
    const chatId = z.number().int().positive().parse(Number(c.req.param('chatId')))
    const input = launch.parse(await c.req.json())
    const parent = getChatStorage()?.getChatMeta(chatId)
    if (!parent || parent.tp !== 'chat' || parent.metadata?.sshEnvironment || parent.metadata?.assistantSpec) {
      throw new DelegationHttpError(400, 'External agents start from a regular workspace conversation')
    }
    const result = await createExternalAgent({
      parent: { chatId }, providerId: input.providerId, model: input.model, effort: input.effort,
      description: input.description, prompt: input.prompt,
      ...(input.target ? { remote: { nodeId: input.target, workspaceId: input.workspaceId } } : {}),
    })
    return c.json(result, 202)
  })
  return app
}
