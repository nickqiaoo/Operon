import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TailscaleInfo } from '@shared/delegations'

/**
 * The phone address: Tailscale Serve publishing this machine's direct
 * listener, driven by the switch in Remote settings. No real Tailscale client
 * is asked; the CLI is a stand-in that remembers its Serve entries.
 */

const cli = vi.hoisted(() => ({
  info: { state: 'running', ipv4: '100.100.0.9', dnsName: 'my-mac.tail1234.ts.net', https: true } as TailscaleInfo,
  /** https port → proxy target */
  serve: new Map<number, string>(),
  refuse: null as string | null,
  calls: [] as string[],
}))

vi.mock('./tailscale.js', () => ({
  detectTailscale: async () => cli.info,
  readServe: async (httpsPort: number) => cli.serve.get(httpsPort) ?? null,
  publishServe: async (httpsPort: number, target: string) => {
    cli.calls.push(`publish ${httpsPort} ${target}`)
    if (cli.refuse) return { ok: false, error: cli.refuse }
    cli.serve.set(httpsPort, target)
    return { ok: true }
  },
  unpublishServe: async (httpsPort: number) => {
    cli.calls.push(`off ${httpsPort}`)
    cli.serve.delete(httpsPort)
  },
}))
vi.mock('../gateway/saas/config.js', () => ({ getSaasConfig: () => ({ nodeId: 'a'.repeat(32) }) }))
vi.mock('./api-token.js', () => ({ API_TOKEN_HEADER: 'x-operon-token', getApiToken: () => 'token', isApiTokenAuthDisabled: () => false }))
vi.mock('./machine-peers.js', () => ({ getMachinePeerLabel: () => null, isTrustedPeer: () => false, trustedPeerIds: () => [] }))
vi.mock('./remote-e2ee.js', () => ({ getConfirmedRemoteDeviceKeys: () => null, getRemoteE2EEMode: () => 'required' }))

const { directLinkTestUtils, getDirectLinkStatus, initDirectLink, ownPhoneAddress, setDirectLinkSettings } = await import('./direct-link.js')

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

let port: number

beforeEach(async () => {
  const kv = new Map<string, unknown>()
  initDirectLink({ get: <T>(key: string) => kv.get(key) as T | undefined, set: (key, value) => { kv.set(key, value) } })
  process.env.OPERON_PORT = '3999'
  cli.info = { state: 'running', ipv4: '100.100.0.9', dnsName: 'my-mac.tail1234.ts.net', https: true }
  cli.serve.clear()
  cli.refuse = null
  cli.calls.length = 0
  port = await freePort()
})

afterEach(() => {
  directLinkTestUtils.reset()
  delete process.env.OPERON_PORT
})

describe('the phone address', () => {
  it('publishes the listener through Tailscale Serve, one port above it', async () => {
    await setDirectLinkSettings({ enabled: true, port })
    expect(cli.calls).toEqual([`publish ${port + 1} http://127.0.0.1:${port}`])
    expect(ownPhoneAddress()).toBe(`https://my-mac.tail1234.ts.net:${port + 1}`)
    expect((await getDirectLinkStatus()).phones).toEqual({ enabled: true, httpsPort: port + 1, address: `https://my-mac.tail1234.ts.net:${port + 1}` })
    // The loopback side Serve proxies to is really listening.
    const ping = await fetch(`http://127.0.0.1:${port}/direct/ping`)
    expect(await ping.json()).toEqual({ v: 1, nodeId: 'a'.repeat(32) })
  })

  it('leaves an entry Serve already has alone', async () => {
    cli.serve.set(port + 1, `http://127.0.0.1:${port}`)
    await setDirectLinkSettings({ enabled: true, port })
    expect(cli.calls).toEqual([])
    expect(ownPhoneAddress()).not.toBeNull()
  })

  it('waits for the tailnet to issue HTTPS certificates', async () => {
    cli.info = { ...cli.info, https: false }
    await setDirectLinkSettings({ enabled: true, port })
    expect(cli.calls).toEqual([])
    expect((await getDirectLinkStatus()).phones).toEqual({ enabled: true, httpsPort: port + 1, needsHttps: true })
  })

  it('says why Serve refused', async () => {
    cli.refuse = 'Turn on HTTPS certificates for your tailnet: https://login.tailscale.com/f/serve?node=x'
    await setDirectLinkSettings({ enabled: true, port })
    expect((await getDirectLinkStatus()).phones).toMatchObject({ enabled: true, error: cli.refuse })
    expect(ownPhoneAddress()).toBeNull()
  })

  it('takes down only its own entry when turned off, or when direct connections are', async () => {
    cli.serve.set(443, 'http://127.0.0.1:3000')
    await setDirectLinkSettings({ enabled: true, port })
    await setDirectLinkSettings({ enabled: false })
    expect(cli.calls.at(-1)).toBe(`off ${port + 1}`)
    expect([...cli.serve.keys()]).toEqual([443])
    expect(ownPhoneAddress()).toBeNull()

    await setDirectLinkSettings({ enabled: true, port })
    await setDirectLinkSettings({ enabled: false })
    expect(cli.calls.at(-1)).toBe(`off ${port + 1}`)
    expect((await getDirectLinkStatus()).phones).toEqual({ enabled: false, httpsPort: port + 1 })
    // Back on, it publishes again.
    await setDirectLinkSettings({ enabled: true })
    expect(ownPhoneAddress()).toBe(`https://my-mac.tail1234.ts.net:${port + 1}`)
  })

  it('moves the entry with the port', async () => {
    await setDirectLinkSettings({ enabled: true, port })
    const next = await freePort()
    await setDirectLinkSettings({ port: next })
    expect(cli.calls.slice(-2)).toEqual([`off ${port + 1}`, `publish ${next + 1} http://127.0.0.1:${next}`])
    expect(ownPhoneAddress()).toBe(`https://my-mac.tail1234.ts.net:${next + 1}`)
  })
})
