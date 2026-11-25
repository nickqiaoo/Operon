import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { isDirectAddress, isTailnetIPv4, localNodeIdFor } from '@shared/delegations'
import { parseTailnetPeers, parseTailscaleStatus, serveProxyFor, tailnetAddressFromInterfaces } from './tailscale.js'

describe('reading tailscale status --json', () => {
  it('takes the IPv4 address and MagicDNS name of a running client', () => {
    expect(parseTailscaleStatus({
      BackendState: 'Running',
      Self: { DNSName: 'my-mac.tail1234.ts.net.', TailscaleIPs: ['fd7a:115c:a1e0::1', '100.101.102.103'] },
    })).toEqual({ state: 'running', ipv4: '100.101.102.103', dnsName: 'my-mac.tail1234.ts.net', https: false })
  })

  it('tells whether the tailnet issues HTTPS certificates', () => {
    const running = { BackendState: 'Running', Self: { DNSName: 'my-mac.tail1234.ts.net.', TailscaleIPs: ['100.101.102.103'] } }
    expect(parseTailscaleStatus({ ...running, CertDomains: ['my-mac.tail1234.ts.net'] })).toMatchObject({ https: true })
    expect(parseTailscaleStatus({ ...running, CertDomains: null })).toMatchObject({ https: false })
  })

  it('tells a signed-out client from a stopped one', () => {
    // As printed by a client that is installed but signed out.
    expect(parseTailscaleStatus({ BackendState: 'NeedsLogin', TailscaleIPs: null, Self: { DNSName: '', TailscaleIPs: null } }))
      .toEqual({ state: 'needs_login' })
    expect(parseTailscaleStatus({ BackendState: 'Stopped' })).toEqual({ state: 'stopped' })
    expect(parseTailscaleStatus({ BackendState: 'Running', Self: { TailscaleIPs: [] } })).toEqual({ state: 'stopped' })
    expect(parseTailscaleStatus(null)).toEqual({ state: 'stopped' })
  })

  it('finds a tailnet address only on a tunnel interface', () => {
    const address = (value: string) => ({ address: value, family: 'IPv4' as const, internal: false, netmask: '255.255.255.255', mac: '', cidr: null })
    expect(tailnetAddressFromInterfaces({ en0: [address('100.70.0.5')], utun4: [address('100.88.1.2')] })).toBe('100.88.1.2')
    // Carrier-grade NAT hands out the same range on ordinary interfaces.
    expect(tailnetAddressFromInterfaces({ en0: [address('100.70.0.5')] })).toBeUndefined()
  })
})

describe('direct addresses another machine may give', () => {
  it('accepts a Tailscale address or MagicDNS name with a port', () => {
    expect(isDirectAddress('http://100.101.102.103:47420')).toBe(true)
    expect(isDirectAddress('https://my-mac.tail1234.ts.net:47420')).toBe(true)
    expect(isDirectAddress('http://[fd7a:115c:a1e0::1]:47420')).toBe(true)
  })

  it('refuses anything that would aim this machine at the LAN or elsewhere', () => {
    for (const value of [
      'http://192.168.1.10:47420', 'http://127.0.0.1:47420', 'http://100.63.0.1:47420', 'http://100.128.0.1:47420',
      'http://100.101.102.103', 'http://100.101.102.103:47420/api', 'http://100.101.102.103:47420/',
      'http://user:pw@100.101.102.103:47420', 'ftp://100.101.102.103:47420', 'http://evil.com:47420',
      'http://ts.net.evil.com:47420', 'not a url', 42, null,
    ]) {
      expect(isDirectAddress(value)).toBe(false)
    }
  })

  it('reads 100.64.0.0/10 exactly', () => {
    expect(isTailnetIPv4('100.64.0.0')).toBe(true)
    expect(isTailnetIPv4('100.127.255.255')).toBe(true)
    expect(isTailnetIPv4('100.63.255.255')).toBe(false)
    expect(isTailnetIPv4('100.128.0.0')).toBe(false)
    expect(isTailnetIPv4('100.64.0')).toBe(false)
  })
})

describe('reading tailscale serve status --json', () => {
  const config = {
    TCP: { 443: { HTTPS: true }, 47421: { HTTPS: true } },
    Web: {
      'my-mac.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } },
      'my-mac.tail1234.ts.net:47421': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47420' } } },
    },
  }

  it('finds where a port is proxied to, beside the user\'s own entries', () => {
    expect(serveProxyFor(config, 47421)).toBe('http://127.0.0.1:47420')
    expect(serveProxyFor(config, 443)).toBe('http://127.0.0.1:3000')
  })

  it('reads nothing published as nothing', () => {
    expect(serveProxyFor({}, 47421)).toBeNull()
    expect(serveProxyFor(null, 47421)).toBeNull()
    expect(serveProxyFor({ TCP: { 47421: { HTTPS: false } }, Web: config.Web }, 47421)).toBeNull()
  })
})

describe('the tailnet\'s other devices', () => {
  it('lists the online ones with an IPv4 address', () => {
    expect(parseTailnetPeers({
      BackendState: 'Running',
      Peer: {
        a: { DNSName: 'studio.tail1234.ts.net.', TailscaleIPs: ['100.90.0.2', 'fd7a:115c:a1e0::2'], Online: true },
        b: { DNSName: 'old-laptop.tail1234.ts.net.', TailscaleIPs: ['100.90.0.3'], Online: false },
        c: { TailscaleIPs: ['fd7a:115c:a1e0::4'], Online: true },
      },
    })).toEqual([{ ipv4: '100.90.0.2', dnsName: 'studio.tail1234.ts.net' }])
    expect(parseTailnetPeers({ BackendState: 'NeedsLogin', Peer: { a: { TailscaleIPs: ['100.90.0.2'], Online: true } } })).toEqual([])
  })
})

describe('the id of a machine that never signed in', () => {
  it('is derived from its key the way Broker checks it (broker/local_node_id_test.go)', () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i)
    const sha256 = (data: Uint8Array) => crypto.createHash('sha256').update(data).digest()
    expect(localNodeIdFor(key, sha256)).toBe('ccccfc504f4c4d34cf7dd00f045114db')
  })
})
