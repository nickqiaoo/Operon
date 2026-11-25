import { DIRECT_PING_PATH, isPhoneDirectAddress, type DirectRouteMode } from '@shared/delegations'

/**
 * Which way this client (the phone app, or the web client in a browser)
 * reaches a machine: through Broker, or directly over Tailscale at the
 * address the machine shares with its paired devices (`DIRECT_INFO_PATH`).
 *
 * Requests are sealed the same either way (secure-fetch.ts), so the route
 * changes nothing about who can read them. Every request still names the
 * machine by its Broker URL; secure-fetch swaps the origin for the direct one
 * when `routeFor` says so. Same rules as between machines
 * (server/src/services/direct-link.ts): Auto tries the direct address when it
 * answers and falls back to Broker; Direct only never uses Broker; Broker only
 * never tries the direct address.
 *
 * Kept per device in localStorage: the address and the mode are this device's
 * view of one machine, not server data.
 *
 * Without an account (`isAccountless`): this device never talks to Broker. It
 * pairs with machines over Tailscale (the QR code carries the address), keeps
 * the list of them here, and names each one by a virtual Broker URL
 * (`DIRECT_ONLY_ORIGIN`) so the rest of the app builds its requests exactly as
 * with an account; secure-fetch sends every one of them directly.
 */

const PROBE_TIMEOUT_MS = 2_500
const PROBE_OK_MS = 60_000
const PROBE_FAILED_MS = 20_000

interface SavedAddress { url: string; at: number }
interface Probe { url: string; ok: boolean; at: number; error?: string }

export type ClientRoute = { kind: 'direct'; base: string; fallback: boolean } | { kind: 'broker' }

export interface ClientRouteStatus {
  mode: DirectRouteMode
  address?: string
  route: 'direct' | 'broker' | 'unknown'
  error?: string
}

/** Thrown when a machine is set to Direct only and cannot be reached that way. */
export class DirectRouteError extends Error {}

const probes = new Map<string, Probe>()
const probing = new Map<string, Promise<Probe>>()
const lastRoute = new Map<string, 'direct' | 'broker'>()

const ACCOUNTLESS_KEY = 'operon.remote.accountless'
const LOCAL_MACHINES_KEY = 'operon.remote.local-machines'

/** Stands in for Broker's origin without an account. Never resolves: secure-fetch swaps it for the machine's direct address. */
export const DIRECT_ONLY_ORIGIN = 'https://direct.operon.invalid'

export function isDirectOnlyUrl(url: string): boolean {
  return url.startsWith(`${DIRECT_ONLY_ORIGIN}/`)
}

/** The base a machine's API is reached at without an account (same shape as Broker's). */
export function directOnlyNodeBaseUrl(nodeId: string): string {
  return `${DIRECT_ONLY_ORIGIN}/u/local/n/${encodeURIComponent(nodeId)}/api`
}

/** This device uses no account: everything goes over Tailscale. */
export function isAccountless(): boolean {
  return read(ACCOUNTLESS_KEY) === '1'
}

export function setAccountless(on: boolean): void {
  write(ACCOUNTLESS_KEY, on ? '1' : null)
  probes.clear()
}

export interface LocalMachine { nodeId: string; label: string }

/** The machines this device paired with over Tailscale, without an account. */
export function listLocalMachines(): LocalMachine[] {
  try {
    const parsed = JSON.parse(read(LOCAL_MACHINES_KEY) ?? '[]') as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is LocalMachine => !!item && typeof item.nodeId === 'string' && typeof item.label === 'string')
      : []
  } catch {
    return []
  }
}

export function rememberLocalMachine(machine: LocalMachine): void {
  write(LOCAL_MACHINES_KEY, JSON.stringify([...listLocalMachines().filter((item) => item.nodeId !== machine.nodeId), machine]))
}

export function forgetLocalMachine(nodeId: string): void {
  write(LOCAL_MACHINES_KEY, JSON.stringify(listLocalMachines().filter((item) => item.nodeId !== nodeId)))
  saveDirectAddress(nodeId, null)
}

const addressKey = (nodeId: string) => `operon.remote.direct.${nodeId}`
const modeKey = (nodeId: string) => `operon.remote.route-mode.${nodeId}`

function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* private mode: this session only knows Broker */ }
}

export function getDirectAddress(nodeId: string): string | null {
  const raw = read(addressKey(nodeId))
  if (!raw) return null
  try {
    const saved = JSON.parse(raw) as Partial<SavedAddress>
    return isPhoneDirectAddress(saved.url) ? saved.url : null
  } catch {
    return null
  }
}

/** What the machine said (pairing code, `DIRECT_INFO_PATH`); null forgets it. Anything but HTTPS on a MagicDNS name is ignored. */
export function saveDirectAddress(nodeId: string, url: string | null): void {
  if (url !== null && !isPhoneDirectAddress(url)) return
  if (url === getDirectAddress(nodeId)) return
  write(addressKey(nodeId), url === null ? null : JSON.stringify({ url, at: Date.now() } satisfies SavedAddress))
  probes.delete(nodeId)
}

export function getRouteMode(nodeId: string): DirectRouteMode {
  // No account, no Broker: there is only the direct route.
  if (isAccountless()) return 'direct'
  const value = read(modeKey(nodeId))
  return value === 'direct' || value === 'broker' ? value : 'auto'
}

export function setRouteMode(nodeId: string, mode: DirectRouteMode): void {
  write(modeKey(nodeId), mode === 'auto' ? null : mode)
  probes.delete(nodeId)
}

async function probe(fetchImpl: typeof fetch, nodeId: string, url: string): Promise<Probe> {
  const cached = probes.get(nodeId)
  if (cached && cached.url === url && Date.now() - cached.at < (cached.ok ? PROBE_OK_MS : PROBE_FAILED_MS)) return cached
  let pending = probing.get(nodeId)
  if (!pending) {
    pending = (async (): Promise<Probe> => {
      try {
        const response = await fetchImpl(`${url}${DIRECT_PING_PATH}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'no-store' })
        const body = response.ok ? await response.json() as { nodeId?: unknown } : null
        if (body?.nodeId !== nodeId) return { url, ok: false, at: Date.now(), error: 'Another machine answers at that address' }
        return { url, ok: true, at: Date.now() }
      } catch {
        return { url, ok: false, at: Date.now(), error: 'Not reachable over Tailscale' }
      }
    })().then((result) => {
      if (probing.get(nodeId) === pending) {
        probes.set(nodeId, result)
        probing.delete(nodeId)
      }
      return result
    })
    probing.set(nodeId, pending)
  }
  return pending
}

/** Which way the next request to `nodeId` goes. `fetchImpl` is the unwrapped fetch. */
export async function routeFor(fetchImpl: typeof fetch, nodeId: string): Promise<ClientRoute> {
  const mode = getRouteMode(nodeId)
  if (mode === 'broker') return { kind: 'broker' }
  const address = getDirectAddress(nodeId)
  if (!address) {
    if (mode === 'direct') throw new DirectRouteError('This device has no Tailscale address saved for this machine.')
    return { kind: 'broker' }
  }
  const result = await probe(fetchImpl, nodeId, address)
  if (result.ok) return { kind: 'direct', base: address, fallback: mode === 'auto' }
  if (mode === 'direct') throw new DirectRouteError(`${result.error ?? 'Not reachable over Tailscale'}. Check that Tailscale is on, on this device and the machine.`)
  return { kind: 'broker' }
}

/** A direct request failed or was turned away: go through Broker until it answers again. */
export function markDirectFailed(nodeId: string, base: string, error = 'The direct connection dropped'): void {
  probes.set(nodeId, { url: base, ok: false, at: Date.now(), error })
}

export function noteRoute(nodeId: string, route: 'direct' | 'broker'): void {
  lastRoute.set(nodeId, route)
}

/** A probe started before the app was suspended cannot describe the resumed connection. */
export function clearRouteProbe(nodeId: string): void {
  probes.delete(nodeId)
  probing.delete(nodeId)
}

/** For the Connection setting; `check` probes the address first. */
export async function clientRouteStatus(fetchImpl: typeof fetch, nodeId: string, check = false): Promise<ClientRouteStatus> {
  const mode = getRouteMode(nodeId)
  const address = getDirectAddress(nodeId) ?? undefined
  let result = probes.get(nodeId)
  if (check && address && mode !== 'broker') result = await probe(fetchImpl, nodeId, address)
  const route: ClientRouteStatus['route'] = mode === 'direct' ? (address && result?.ok && result.url === address ? 'direct' : 'unknown')
    : mode === 'broker' || !address ? 'broker'
    : result ? (result.ok && result.url === address ? 'direct' : 'broker')
      : lastRoute.get(nodeId) ?? 'unknown'
  return {
    mode,
    ...(address ? { address } : {}),
    route,
    ...(result && !result.ok && result.error && mode !== 'broker' ? { error: result.error } : {}),
  }
}

/**
 * Refusals the direct listener gives before anything reaches the machine's
 * server (direct-ingress.ts), so the same request may still go through Broker.
 */
export const DIRECT_TURNED_AWAY = new Set(['direct_unavailable', 'starting', 'direct_device_unknown'])

export const remoteRouteTestUtils = {
  reset(): void {
    probes.clear()
    probing.clear()
    lastRoute.clear()
  },
}
