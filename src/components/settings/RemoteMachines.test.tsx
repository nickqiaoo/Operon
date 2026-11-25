// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IntlProvider } from 'react-intl'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachinePairingCodeStatus, MachinePeer } from '@shared/delegations'

const peer = (nodeId: string, extra: Partial<MachinePeer> = {}): MachinePeer => ({
  nodeId, fingerprint: 'ABCD-EFGH', status: 'trusted', source: 'paired', changedAt: 1, ...extra,
})

const api = vi.hoisted(() => ({
  machinePeers: vi.fn(),
  delegationMachines: vi.fn(),
  startMachinePairing: vi.fn(),
  machinePairingStatus: vi.fn(),
  cancelMachinePairing: vi.fn(),
  joinMachinePairing: vi.fn(),
  revokeMachinePeer: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ api }))
vi.mock('@/lib/chat-api-context', () => ({
  apiOn: () => api,
  onNode: (key: readonly unknown[]) => key,
  useChatNodeId: () => undefined,
}))

const { RemoteMachines } = await import('./RemoteMachines')

let root: Root
let container: HTMLDivElement
let codeStatus: MachinePairingCodeStatus

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  codeStatus = { status: 'waiting' }
  api.machinePeers.mockResolvedValue({
    peers: [peer('b'.repeat(32)), peer('c'.repeat(32), { source: 'introduced', introducedBy: 'b'.repeat(32) }), peer('d'.repeat(32), { status: 'revoked' })],
  })
  api.delegationMachines.mockResolvedValue({ machines: [
    { nodeId: 'a'.repeat(32), label: 'Mini', online: true, current: true },
    { nodeId: 'f'.repeat(32), label: 'Office', online: true, current: false, paired: false },
    { nodeId: 'b'.repeat(32), label: 'Studio', online: true, current: false, paired: true },
  ] })
  api.startMachinePairing.mockResolvedValue({ code: 'ABCD-EFGH-JKMN-PQRS', expiresAt: Date.now() + 300_000 })
  api.machinePairingStatus.mockImplementation(async () => codeStatus)
  api.cancelMachinePairing.mockResolvedValue({ ok: true })
  api.joinMachinePairing.mockResolvedValue({ peer: peer('e'.repeat(32), { label: 'Laptop' }) })
  api.revokeMachinePeer.mockResolvedValue({ peer: peer('b'.repeat(32), { status: 'revoked' }) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <RemoteMachines />
      </IntlProvider>
    </QueryClientProvider>,
  ))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const button = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name)
const settle = () => act(async () => { await vi.waitFor(() => undefined); await new Promise((r) => setTimeout(r, 0)) })

describe('RemoteMachines', () => {
  it('lists every machine once, with whether and how it is paired', async () => {
    await vi.waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(4))
    const rows = [...container.querySelectorAll('li')].map((li) => li.textContent)
    // This machine, then paired (including one Broker no longer lists), then the rest.
    expect(rows[0]).toContain('This machine')
    expect(rows[1]).toMatch(/Studio.*Paired.*Online/)
    expect(rows[2]).toMatch(/cccccccc.*Paired through Studio.*Offline/)
    expect(rows[3]).toMatch(/Office.*Not paired/)
    // The revoked machine is not listed, and only paired machines can be unpaired.
    expect(container.textContent).not.toContain('dddddddd')
    expect(button('Unpair Office')).toBeUndefined()
  })

  it('shows a code, and says so when the other machine used it', async () => {
    await act(async () => button('Show code')!.click())
    await vi.waitFor(() => expect(container.querySelector('[aria-label="Pairing code"]')?.textContent).toBe('ABCD-EFGH-JKMN-PQRS'))
    expect(container.textContent).toContain('expires in 5:00')
    codeStatus = { status: 'paired', peer: peer('b'.repeat(32)) }
    await vi.waitFor(() => expect(container.textContent).toContain('Paired with Studio.'), { timeout: 3_000 })
    expect(container.querySelector('[aria-label="Pairing code"]')).toBeNull()
  })

  it('pairs with a code entered here', async () => {
    await act(async () => button('Enter code')!.click())
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Pairing code"]')!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(input, 'abcd efgh jkmn pqrs')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Pair')!.click())
    await settle()
    expect(api.joinMachinePairing).toHaveBeenCalledWith('abcd efgh jkmn pqrs')
    await vi.waitFor(() => expect(container.textContent).toContain('Paired with Laptop.'))
  })

  it('unpairs a machine', async () => {
    await vi.waitFor(() => expect(button('Unpair Studio')).toBeTruthy())
    await act(async () => button('Unpair Studio')!.click())
    await settle()
    expect(api.revokeMachinePeer).toHaveBeenCalledWith('b'.repeat(32))
  })
})
