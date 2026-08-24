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

  app.post('/pair/session/:pairingId/approve', (c) => {
    if (isRemote(c)) return c.json({ error: 'local_only' }, 403)
    return c.json(approveRemotePairing(c.req.param('pairingId')))
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
