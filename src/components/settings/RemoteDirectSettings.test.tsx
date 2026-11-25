// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IntlProvider } from 'react-intl'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectLinkStatus } from '@shared/delegations'

const studio = 'b'.repeat(32)
const laptop = 'c'.repeat(32)

const api = vi.hoisted(() => ({
  directLinkStatus: vi.fn(),
  setDirectLink: vi.fn(),
  setDirectPeerMode: vi.fn(),
  machinePeers: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ api }))

const { RemoteDirectSettings } = await import('./RemoteDirectSettings')

let root: Root
let container: HTMLDivElement

const phonesOff = { enabled: false, httpsPort: 47_421 }
const signedIn = { enabled: true, signedIn: true }
const off: DirectLinkStatus = { enabled: false, port: 47_420, tailscale: { state: 'needs_login' }, peers: [], phones: phonesOff, broker: signedIn }
const on: DirectLinkStatus = {
  enabled: true,
  port: 47_420,
  tailscale: { state: 'running', ipv4: '100.101.102.103', dnsName: 'mini.tail1234.ts.net' },
  address: 'http://100.101.102.103:47420',
  peers: [
    { nodeId: studio, address: 'http://100.90.0.2:47420', mode: 'auto', route: 'direct', checkedAt: 1 },
    { nodeId: laptop, mode: 'auto', route: 'broker' },
  ],
  phones: phonesOff,
  broker: signedIn,
}

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

function render(status: DirectLinkStatus) {
  api.directLinkStatus.mockResolvedValue(status)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <RemoteDirectSettings />
      </IntlProvider>
    </QueryClientProvider>,
  ))
}

beforeEach(() => {
  vi.clearAllMocks()
  api.machinePeers.mockResolvedValue({ peers: [
    { nodeId: studio, label: 'Studio', fingerprint: 'F', status: 'trusted', source: 'paired', changedAt: 1 },
    { nodeId: laptop, label: 'Laptop', fingerprint: 'F', status: 'trusted', source: 'paired', changedAt: 1 },
  ] })
  api.setDirectLink.mockResolvedValue(on)
  api.setDirectPeerMode.mockResolvedValue(on)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const toggle = () => container.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Direct connections (Tailscale)"]')!

describe('RemoteDirectSettings', () => {
  it('says what Tailscale is doing while off, and turns on', async () => {
    render(off)
    await vi.waitFor(() => expect(container.textContent).toContain('Installed, not signed in'))
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(container.querySelector('li')).toBeNull()
    await act(async () => toggle().click())
    expect(api.setDirectLink).toHaveBeenCalledWith({ enabled: true })
    await vi.waitFor(() => expect(container.textContent).toContain('http://100.101.102.103:47420'))
  })

  it('lists paired machines with the route each takes, by name', async () => {
    render(on)
    await vi.waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(2))
    const [first, second] = [...container.querySelectorAll('li')].map((li) => li.textContent)
    expect(first).toMatch(/Studio.*100\.90\.0\.2.*Direct/)
    expect(second).toMatch(/Laptop.*This computer has no Tailscale address for this device.*Via Broker/)
    expect(container.textContent).toContain('Connected · mini.tail1234.ts.net')
  })

  it('shows why it is on but not listening', async () => {
    render({ ...on, address: undefined, error: 'Port 47420 is in use. Pick another port.', peers: [] })
    await vi.waitFor(() => expect(container.textContent).toContain('Port 47420 is in use'))
  })

  it('publishes for phones, and shows the address phones get', async () => {
    const published: DirectLinkStatus = { ...on, phones: { enabled: true, httpsPort: 47_421, address: 'https://mini.tail1234.ts.net:47421' } }
    render(published)
    await vi.waitFor(() => expect(container.textContent).toContain('https://mini.tail1234.ts.net:47421'))
  })

  it('points to the admin console while the tailnet issues no HTTPS certificates', async () => {
    render({ ...on, phones: { enabled: true, httpsPort: 47_421, needsHttps: true } })
    await vi.waitFor(() => expect(container.textContent).toContain('HTTPS Certificates'))
    expect(container.querySelector<HTMLAnchorElement>('a[href="https://login.tailscale.com/admin/dns"]')).not.toBeNull()
  })

  it('turns Broker off, and then offers no route to choose per machine', async () => {
    const withoutBroker: DirectLinkStatus = { ...on, broker: { enabled: false, signedIn: true } }
    api.setDirectLink.mockResolvedValue(withoutBroker)
    render(on)
    const brokerToggle = () => container.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Use Broker"]')!
    await vi.waitFor(() => expect(brokerToggle().getAttribute('aria-checked')).toBe('true'))
    expect(container.querySelectorAll('li button[role="combobox"]').length).toBe(2)
    await act(async () => brokerToggle().click())
    expect(api.setDirectLink).toHaveBeenCalledWith({ broker: false })
    await vi.waitFor(() => expect(container.querySelectorAll('li button[role="combobox"]').length).toBe(0))
  })
})
