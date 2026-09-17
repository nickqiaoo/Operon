import { Hono } from 'hono'
import {
  PAIRING_HEADER,
  E2EE_PROOF_HEADER,
  REMOTE_E2EE_VERSION,
  REMOTE_TUNNEL_HEADER,
  decodeEnvelope,
} from '@shared/e2ee/protocol'
import {
  approveRemotePairing,
  claimRemotePairing,
  getPairingApprovalNonce,
  requiresSecureApproval,
  getRemotePairingStatus,
  inspectRemotePairing,
  listRemoteDevices,
  rejectRemotePairing,
  revokeRemoteDevice,
  startRemotePairing,
} from '../services/remote-e2ee.js'

interface ClaimBody {
  pairingId?: string
  envelope?: unknown
}

function isRemote(c: { req: { header(name: string): string | undefined } }): boolean {
  return c.req.header(REMOTE_TUNNEL_HEADER) === '1'
}

export function remoteE2EERoutes(): Hono {
  const app = new Hono()

  app.post('/pair/start', (c) => {
    if (isRemote(c)) return c.json({ error: 'local_only' }, 403)
    return c.json(startRemotePairing())
  })

  app.post('/pair/claim', async (c) => {
    if (!isRemote(c) || c.req.header(PAIRING_HEADER) !== REMOTE_E2EE_VERSION) {
      return c.json({ error: 'invalid_pairing_transport' }, 403)
    }
    const body = await c.req.json<ClaimBody>()
    if (typeof body.pairingId !== 'string' || typeof body.envelope !== 'object' || !body.envelope) {
      return c.json({ error: 'invalid_pairing_claim' }, 400)
    }
    return c.json(claimRemotePairing({
      pairingId: body.pairingId,
      envelope: decodeEnvelope(JSON.stringify(body.envelope)),
    }))
  })

  app.get('/pair/status/:pairingId', (c) => {
    if (!isRemote(c) || c.req.header(PAIRING_HEADER) !== REMOTE_E2EE_VERSION) {
      return c.json({ error: 'invalid_pairing_transport' }, 403)
    }
    const proof = c.req.header(E2EE_PROOF_HEADER)
    if (!proof) return c.json({ error: 'missing_pairing_proof' }, 400)
    return c.json(getRemotePairingStatus({
      pairingId: c.req.param('pairingId'),
      proof: decodeEnvelope(proof),
    }))
  })

  app.get('/pair/session/:pairingId', (c) => {
    if (isRemote(c)) return c.json({ error: 'local_only' }, 403)
    return c.json(inspectRemotePairing(c.req.param('pairingId')))
  })

  // Approval is the one call that mints a persistent, internet-reachable
  // credential, so it does not settle for the api-token gate. Where the host
  // offers a channel a same-user HTTP caller cannot reach (Electron IPC), this
  // route is closed and the desktop UI approves through that instead. Headless
  // servers have no such channel and keep this path, reading the nonce straight
  // out of memory below — there it is bookkeeping, not a barrier. That downgrade
  // is inherent rather than sloppy: on a headless box every credential the UI
  // can obtain, a same-user attacker can obtain too.
  app.post('/pair/session/:pairingId/approve', (c) => {
    if (isRemote(c)) return c.json({ error: 'local_only' }, 403)
    if (requiresSecureApproval()) {
      return c.json({ error: 'approval_requires_desktop_ui' }, 403)
    }
    const pairingId = c.req.param('pairingId')
    const nonce = getPairingApprovalNonce(pairingId)
    if (!nonce) return c.json({ error: 'Pairing request is missing or expired' }, 400)
    return c.json(approveRemotePairing(pairingId, nonce))
  })

  app.post('/pair/session/:pairingId/reject', (c) => {
    if (isRemote(c)) return c.json({ error: 'local_only' }, 403)
    rejectRemotePairing(c.req.param('pairingId'))
    return c.json({ ok: true })
  })

  app.get('/devices', (c) => {
    if (isRemote(c)) return c.json({ error: 'local_only' }, 403)
    return c.json({ devices: listRemoteDevices() })
  })

  app.delete('/devices/:id', (c) => {
    if (isRemote(c)) return c.json({ error: 'local_only' }, 403)
    const id = Number(c.req.param('id'))
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'invalid_device_id' }, 400)
    revokeRemoteDevice(id)
    return c.json({ ok: true })
  })

  return app
}
