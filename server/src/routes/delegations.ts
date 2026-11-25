import { hostname } from 'node:os'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  DELEGATION_NODE_ID, DELEGATION_PROVIDER_ID, type DelegatedAgentEvent, type DelegatedAgentStarted,
} from '@shared/delegations'
import { DELEGATION_SOURCE_HEADER, DELEGATION_SOURCE_LABEL_HEADER, DELEGATION_TUNNEL_HEADER, REMOTE_TUNNEL_HEADER } from '@shared/e2ee/protocol'
import { delegationProviderIds, type DelegationHost } from '../services/delegation-host.js'
import { DelegationHttpError, listDelegationNodes } from '../services/delegation-transport.js'
import {
  createExternalAgent, externalAgentView, getExternalAgentStatus, sendExternalAgent, stopExternalAgent,
} from '../services/external-agent.js'
import { receiveAgentEvent } from '../services/remote-agents.js'
import {
  answerPairingClaim, cancelPairingCode, joinWithPairingCode, pairingCodeStatus, receivePeerSync, schedulePeerSync, startPairingCode,
} from '../services/machine-pairing.js'
import { listMachinePeers, revokePeer } from '../services/machine-peers.js'
import { getDirectLinkStatus, setBrokerEnabled, setDirectLinkSettings, setPeerMode } from '../services/direct-link.js'
import { startSaasRuntime, stopSaasRuntime } from '../services/saas-runtime.js'
import { trustedDelegationTunnel } from '../services/delegation-tunnel.js'
import { createNodeEnrollmentCode, joinWithNodeEnrollmentCode, leaveAccount, nodeAccountStatus } from '../services/node-enrollment.js'

const nodeId = z.string().regex(DELEGATION_NODE_ID)
const providerId = z.string().regex(DELEGATION_PROVIDER_ID)
const setting = z.string().trim().min(1).max(250)
const positiveId = z.number().int().positive()
const agentCreate = z.object({
  parentChatId: positiveId, providerId, model: setting, effort: setting.optional(),
  description: z.string().trim().min(1).max(300), prompt: z.string().trim().min(1).max(100_000), workspaceId: positiveId,
})
const agentCall = z.object({
  parentChatId: positiveId, prompt: z.string().trim().min(1).max(100_000).optional(),
  mode: z.enum(['auto', 'steer', 'followup']).optional(),
})
const turnStatus = z.enum(['running', 'queued'])
const agentEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('settings'), childChatId: positiveId, eventId: z.string().uuid(), modelId: setting.optional(), effort: setting.optional() }),
  z.object({ type: z.literal('turn'), childChatId: positiveId, turnId: z.string().min(1).max(200), status: turnStatus }),
  z.object({
    type: z.literal('result'), childChatId: positiveId, turnId: z.string().min(1).max(200),
    status: z.enum(['completed', 'cancelled', 'failed']), error: z.string().max(20_000).optional(),
    dispatched: z.boolean(), prompt: z.string().max(20_000), result: z.string().max(40_000),
    workspace: z.object({ id: positiveId, branch: z.string().max(500), worktreePath: z.string().max(4_000) }).optional(),
  }),
])

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
  // External agents another machine's conversation starts here. The agent is an
  // ordinary one of this machine; its owner is (source machine, parent chat id).
  app.post('/agents', async (c) => {
    const from = source(c)
    const input = agentCreate.parse(await c.req.json())
    const providers = delegationProviderIds()
    if (!providers.includes(input.providerId)) {
      throw new DelegationHttpError(400, `Available agents on this machine: ${providers.join(', ') || 'none'}`)
    }
    const started = await createExternalAgent({
      parent: { remoteParent: { nodeId: from.id, ...(from.label ? { label: from.label } : {}), chatId: input.parentChatId }, workspaceId: input.workspaceId },
      providerId: input.providerId, model: input.model, effort: input.effort, description: input.description, prompt: input.prompt,
    })
    const view = 'chat_id' in started ? externalAgentView(started.chat_id) : undefined
    if (!view || !('turn_id' in started)) throw new DelegationHttpError(500, 'The agent did not start')
    const answer: DelegatedAgentStarted = {
      childChatId: view.childChatId, workspaceId: input.workspaceId, providerId: view.providerId,
      effort: view.effort,
      ...(view.modelId ? { modelId: view.modelId } : {}), ...(view.modeId ? { modeId: view.modeId } : {}),
      turnId: started.turn_id, status: started.status === 'queued' ? 'queued' : 'running',
      ...(started.delivery ? { delivery: started.delivery } : {}),
      ...('warning' in started && typeof started.warning === 'string' ? { warning: started.warning } : {}),
    }
    return c.json(answer)
  })
  const ownerOf = (c: Context, parentChatId: number) => ({ nodeId: source(c).id, chatId: parentChatId })
  const agentIdOf = (c: Context) => `ext-${positiveId.parse(Number(c.req.param('childChatId')))}`
  app.post('/agents/:childChatId/send', async (c) => {
    const input = agentCall.parse(await c.req.json())
    if (!input.prompt) throw new DelegationHttpError(400, 'prompt is required')
    return c.json(await sendExternalAgent(ownerOf(c, input.parentChatId), agentIdOf(c), input.prompt, input.mode ?? 'auto'))
  })
  app.post('/agents/:childChatId/stop', async (c) => {
    const input = agentCall.parse(await c.req.json())
    return c.json(stopExternalAgent(ownerOf(c, input.parentChatId), agentIdOf(c)))
  })
  app.post('/agents/:childChatId/status', async (c) => {
    const input = agentCall.parse(await c.req.json())
    return c.json(getExternalAgentStatus(ownerOf(c, input.parentChatId), agentIdOf(c)))
  })
  // A turn of an agent this machine's conversation started on the source machine.
  // Reaches here even while this machine serves no others (see app.ts).
  app.post('/agent-events', async (c) => {
    const from = source(c)
    receiveAgentEvent(from.id, agentEvent.parse(await c.req.json()) as DelegatedAgentEvent)
    return c.json({ ok: true })
  })

  // Pairing (machine-pairing.ts). The claim reaches here from a machine not yet
  // paired, unsealed by the transport (see remote-e2ee.ts); the sync only from a
  // paired one. Neither depends on the receive switch.
  app.post('/pair/claim', async (c) => {
    const from = source(c)
    const answer = answerPairingClaim(from.id, await c.req.json())
    return c.json(answer.body, answer.status)
  })
  app.post('/peers/sync', async (c) => {
    const from = source(c)
    return c.json(receivePeerSync(from.id, await c.req.json()))
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
  // Pairing is done by someone at both machines, so only from this machine's own window.
  app.get('/local/peers', (c) => c.json({ peers: listMachinePeers() }))
  app.post('/local/pair/code', (c) => {
    onThisMachine(c)
    return c.json(startPairingCode())
  })
  app.get('/local/pair/code', (c) => {
    onThisMachine(c)
    return c.json(pairingCodeStatus())
  })
  app.delete('/local/pair/code', (c) => {
    onThisMachine(c)
    cancelPairingCode()
    return c.json({ ok: true })
  })
  app.post('/local/pair/join', async (c) => {
    onThisMachine(c)
    const { code } = z.object({ code: z.string().trim().min(1).max(64) }).parse(await c.req.json())
    return c.json({ peer: await joinWithPairingCode(code) })
  })
  // Adding a server with no browser (see node-enrollment.ts). The desktop asks for
  // the code; the server redeems it, driven by `operon node join` over loopback.
  app.post('/local/enroll/code', async (c) => {
    onThisMachine(c)
    return c.json(await createNodeEnrollmentCode())
  })
  app.post('/local/enroll/join', async (c) => {
    onThisMachine(c)
    const body = z.object({ code: z.string().trim().min(1).max(128), label: z.string().trim().max(80).optional() }).parse(await c.req.json())
    return c.json(await joinWithNodeEnrollmentCode(body.code, body.label || hostname(), (enabled) => host.setAccepting(enabled)))
  })
  app.get('/local/account', async (c) => {
    onThisMachine(c)
    return c.json({ ...(await nodeAccountStatus()), acceptingOtherMachines: host.accepting() })
  })
  app.post('/local/account/leave', async (c) => {
    onThisMachine(c)
    return c.json(await leaveAccount())
  })
  // Direct connections over Tailscale (direct-link.ts).
  app.get('/local/direct', async (c) => {
    onThisMachine(c)
    return c.json(await getDirectLinkStatus({ probe: c.req.query('probe') === '1' }))
  })
  app.post('/local/direct', async (c) => {
    onThisMachine(c)
    const input = z.object({
      enabled: z.boolean().optional(),
      // One above it is the phone address (directHttpsPort).
      port: z.number().int().min(1024).max(65_534).optional(),
      broker: z.boolean().optional(),
    }).parse(await c.req.json())
    const { broker, ...link } = input
    if (broker !== undefined) {
      setBrokerEnabled(broker)
      if (broker) startSaasRuntime()
      else stopSaasRuntime()
    }
    if (link.enabled !== undefined || link.port !== undefined) await setDirectLinkSettings(link)
    return c.json(await getDirectLinkStatus({ probe: true }))
  })
  app.post('/local/direct/peers/:nodeId', async (c) => {
    onThisMachine(c)
    const { mode } = z.object({ mode: z.enum(['auto', 'direct', 'broker']) }).parse(await c.req.json())
    setPeerMode(nodeId.parse(c.req.param('nodeId')), mode)
    return c.json(await getDirectLinkStatus({ probe: true }))
  })
  app.post('/local/peers/:nodeId/revoke', (c) => {
    onThisMachine(c)
    const peer = revokePeer(nodeId.parse(c.req.param('nodeId')))
    if (!peer) throw new DelegationHttpError(404, 'This machine was never paired with that one')
    schedulePeerSync()
    return c.json({ peer })
  })
  return app
}
