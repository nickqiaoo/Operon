import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeviceKeypair, fingerprintPublicKey, open, seal } from '@shared/e2ee/crypto'
import { bytesToBase64, utf8, type SealedEnvelope } from '@shared/e2ee/protocol'
import type { MachinePeerRecord } from '@shared/delegations'
import type { MachinePeerRow, MachinePeerStorageAdapter, MachinePeerWrite } from '../storage/interface.js'
import { ReplayGuard, parseE2EETime } from './replay-guard.js'
import { initMachinePeers, isTrustedPeer, listMachinePeers, mergePeerRecords, pinPairedPeer, revokePeer } from './machine-peers.js'
import {
  answerPairingClaim, decodePairingCode, encodePairingCode, machinePairingTestUtils, pairingAad, pairingCodeStatus,
  pairingSecrets, startPairingCode,
} from './machine-pairing.js'

const self = 'a'.repeat(32)
const ownKey = createDeviceKeypair()

vi.mock('../gateway/saas/config.js', () => ({
  getSaasConfig: () => ({ nodeId: 'a'.repeat(32), nodeToken: 'token', userId: 'u'.repeat(32), label: 'This Mac' }),
}))
vi.mock('./mobile/identity.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./mobile/identity.js')>(),
  getDelegationKeypair: () => ({ ...ownKey, fingerprint: fingerprintPublicKey(ownKey.publicKey) }),
}))

class MemoryPeers implements MachinePeerStorageAdapter {
  rows = new Map<string, MachinePeerRow>()
  private nextId = 1
  getMachinePeer(nodeId: string) { return this.rows.get(nodeId) ?? null }
  listMachinePeers() { return [...this.rows.values()].sort((a, b) => b.changedAt - a.changedAt) }
  upsertMachinePeer(input: MachinePeerWrite) {
    const previous = this.rows.get(input.nodeId)
    const row: MachinePeerRow = { ...input, id: previous?.id ?? this.nextId++, createdAt: previous?.createdAt ?? Date.now(), lastSeenAt: previous?.lastSeenAt ?? null }
    this.rows.set(input.nodeId, row)
    return row
  }
  touchMachinePeer(nodeId: string, ts: number) {
    const row = this.rows.get(nodeId)
    if (row) row.lastSeenAt = ts
  }
}

let peers: MemoryPeers
beforeEach(() => {
  peers = new MemoryPeers()
  initMachinePeers(peers)
  machinePairingTestUtils.reset()
})

const machine = (c: string) => c.repeat(32)
const record = (nodeId: string, key: Uint8Array, status: MachinePeerRecord['status'], changedAt: number): MachinePeerRecord =>
  ({ nodeId, publicKey: bytesToBase64(key), status, changedAt })

describe('ReplayGuard', () => {
  it('takes a timed request once, and refuses one outside the window', () => {
    let now = 1_000_000
    const guard = new ReplayGuard(60_000, () => now)
    expect(guard.check('n1', now)).toBe('fresh')
    expect(guard.check('n1', now)).toBe('replayed')
    expect(guard.check('n2', now - 60_001)).toBe('stale')
    expect(guard.check('n3', now + 60_001)).toBe('stale')
    expect(guard.check('n4', Number.NaN)).toBe('stale')
    // Once its time leaves the window the nonce is forgotten; the time check takes over.
    now += 120_000
    guard.check('other', now)
    expect(guard.size).toBe(1)
    expect(guard.check('n1', now - 120_000)).toBe('stale')
  })

  it('remembers an untimed request for two windows', () => {
    let now = 1_000_000
    const guard = new ReplayGuard(60_000, () => now)
    expect(guard.check('legacy')).toBe('fresh')
    now += 119_000
    expect(guard.check('legacy')).toBe('replayed')
  })

  it('reads the time header strictly', () => {
    expect(parseE2EETime(undefined)).toBeUndefined()
    expect(parseE2EETime('1700000000000')).toBe(1_700_000_000_000)
    expect(parseE2EETime('1e12')).toBeNaN()
    expect(parseE2EETime('-1')).toBeNaN()
  })
})

describe('pairing codes', () => {
  it('round-trips, forgiving case, spacing and look-alike letters', () => {
    const secret = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7])
    const code = encodePairingCode(secret)
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/)
    expect(decodePairingCode(code)).toEqual(secret)
    expect(decodePairingCode(code.toLowerCase().replace(/-/g, ' '))).toEqual(secret)
    expect(decodePairingCode(code.replace(/0/g, 'O').replace(/1/g, 'l'))).toEqual(secret)
    expect(decodePairingCode('ABCD')).toBeNull()
    expect(decodePairingCode('UUUU-UUUU-UUUU-UUUU')).toBeNull()
  })
})

describe('answering a pairing claim', () => {
  const claimer = machine('b')
  const claimerKey = createDeviceKeypair()
  const claimFor = (code: string, sealedBy = claimer, shower = self) => {
    const { pairingId, key } = pairingSecrets(decodePairingCode(code)!)
    const hello = { nodeId: claimer, publicKey: bytesToBase64(claimerKey.publicKey), label: 'Laptop', challenge: 'c'.repeat(24) }
    return { pairingId, key, body: { pairingId, envelope: seal(utf8(JSON.stringify(hello)), key, pairingAad(pairingId, 'claim', sealedBy, shower)) } }
  }

  it('pins the claimer and answers with this machine\'s key, bound to the claim', () => {
    const { code } = startPairingCode()
    const { pairingId, key, body } = claimFor(code)
    const answer = answerPairingClaim(claimer, body)
    expect(answer.status).toBe(200)
    const opened = JSON.parse(new TextDecoder().decode(open(answer.body.envelope as SealedEnvelope, key, pairingAad(pairingId, 'answer', claimer, self))))
    expect(opened).toMatchObject({ nodeId: self, publicKey: bytesToBase64(ownKey.publicKey), label: 'This Mac', challenge: 'c'.repeat(24) })
    expect(isTrustedPeer(claimer)).toBe(true)
    expect(pairingCodeStatus()).toMatchObject({ status: 'paired', peer: { nodeId: claimer, label: 'Laptop', source: 'paired' } })
    // The code is spent.
    expect(answerPairingClaim(claimer, body).status).toBe(404)
  })

  it('refuses a claim Broker attributes to another machine', () => {
    const { code } = startPairingCode()
    // Sealed by b, delivered as if from c.
    expect(answerPairingClaim(machine('c'), claimFor(code).body).status).toBe(400)
    expect(isTrustedPeer(machine('c'))).toBe(false)
    expect(isTrustedPeer(claimer)).toBe(false)
  })

  it('refuses a claim meant for another machine', () => {
    const { code } = startPairingCode()
    expect(answerPairingClaim(claimer, claimFor(code, claimer, machine('d')).body).status).toBe(400)
  })

  it('withdraws the code after repeated bad claims', () => {
    const { code } = startPairingCode()
    const { body } = claimFor(code)
    const bad = { ...body, envelope: { ...body.envelope, ciphertext: bytesToBase64(new Uint8Array(40)) } }
    for (let i = 0; i < 5; i++) expect(answerPairingClaim(claimer, bad).status).toBe(400)
    expect(answerPairingClaim(claimer, body).status).toBe(404)
    expect(pairingCodeStatus().status).toBe('expired')
  })

  it('answers 404 for a code it is not showing', () => {
    startPairingCode()
    expect(answerPairingClaim(claimer, claimFor('0000-0000-0000-0000').body).status).toBe(404)
  })
})

describe('what paired machines tell each other', () => {
  const friend = machine('b')
  const third = machine('c')
  const thirdKey = createDeviceKeypair()

  beforeEach(() => {
    pinPairedPeer({ nodeId: friend, publicKey: createDeviceKeypair().publicKey, label: 'Friend', at: 1_000 })
  })

  it('learns a machine a trusted one paired with, and records who vouched', () => {
    expect(mergePeerRecords(friend, self, [record(third, thirdKey.publicKey, 'trusted', 2_000)])).toBe(true)
    expect(listMachinePeers().find((p) => p.nodeId === third)).toMatchObject({ status: 'trusted', source: 'introduced', introducedBy: friend })
    expect(isTrustedPeer(third)).toBe(true)
    // Nothing new the second time.
    expect(mergePeerRecords(friend, self, [record(third, thirdKey.publicKey, 'trusted', 2_000)])).toBe(false)
  })

  it('takes nothing from a machine it does not trust', () => {
    expect(mergePeerRecords(machine('e'), self, [record(third, thirdKey.publicKey, 'trusted', 2_000)])).toBe(false)
    expect(isTrustedPeer(third)).toBe(false)
  })

  it('ignores records about itself and about the sender', () => {
    expect(mergePeerRecords(friend, self, [
      record(self, createDeviceKeypair().publicKey, 'revoked', 9_000),
      record(friend, createDeviceKeypair().publicKey, 'revoked', 9_000),
    ])).toBe(false)
    expect(isTrustedPeer(friend)).toBe(true)
  })

  it('lets a revocation spread, and keeps an older trust record from undoing it', () => {
    mergePeerRecords(friend, self, [record(third, thirdKey.publicKey, 'trusted', 2_000)])
    expect(mergePeerRecords(friend, self, [record(third, thirdKey.publicKey, 'revoked', 3_000)])).toBe(true)
    expect(isTrustedPeer(third)).toBe(false)
    expect(mergePeerRecords(friend, self, [record(third, thirdKey.publicKey, 'trusted', 2_500)])).toBe(false)
    // At the same time, the revocation wins.
    expect(mergePeerRecords(friend, self, [record(third, thirdKey.publicKey, 'trusted', 3_000)])).toBe(false)
    expect(isTrustedPeer(third)).toBe(false)
  })

  it('brings a revoked machine back only with a later record (a new pairing)', () => {
    pinPairedPeer({ nodeId: third, publicKey: thirdKey.publicKey, label: 'Third', at: 2_000 })
    revokePeer(third, 3_000)
    const repaired = createDeviceKeypair()
    expect(mergePeerRecords(friend, self, [record(third, repaired.publicKey, 'trusted', 4_000)])).toBe(true)
    expect(listMachinePeers().find((p) => p.nodeId === third)).toMatchObject({
      status: 'trusted', source: 'introduced', fingerprint: fingerprintPublicKey(repaired.publicKey),
    })
  })

  it('keeps a machine paired here "paired" when only its label or status changes', () => {
    pinPairedPeer({ nodeId: third, publicKey: thirdKey.publicKey, label: 'Third', at: 2_000 })
    mergePeerRecords(friend, self, [{ ...record(third, thirdKey.publicKey, 'revoked', 3_000), label: 'Renamed' }])
    expect(listMachinePeers().find((p) => p.nodeId === third)).toMatchObject({ status: 'revoked', source: 'paired', label: 'Renamed' })
  })

  it('drops malformed and far-future records', () => {
    expect(mergePeerRecords(friend, self, [
      null, 'x', { nodeId: 'short', publicKey: bytesToBase64(thirdKey.publicKey), status: 'trusted', changedAt: 1 },
      { ...record(third, new Uint8Array(31), 'trusted', 2_000) },
      { ...record(third, thirdKey.publicKey, 'trusted', 2_000), status: 'admin' },
      record(third, thirdKey.publicKey, 'trusted', Date.now() + 7 * 24 * 60 * 60_000),
    ])).toBe(false)
    expect(peers.rows.has(third)).toBe(false)
  })
})
