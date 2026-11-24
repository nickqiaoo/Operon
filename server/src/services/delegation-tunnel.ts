import { randomBytes, timingSafeEqual } from 'node:crypto'

// Kept in the host process for the embedded tunnel. A separately launched tunnel
// can share an explicit secret with a headless server.
export const delegationTunnelToken = process.env.OPERON_DELEGATION_TUNNEL_TOKEN || randomBytes(32).toString('hex')

export function trustedDelegationTunnel(value: string | undefined): boolean {
  const expected = Buffer.from(delegationTunnelToken)
  const received = Buffer.from(value ?? '')
  return received.length === expected.length && timingSafeEqual(received, expected)
}
