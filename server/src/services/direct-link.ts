import type http from 'node:http'
import {
  DEFAULT_DIRECT_PORT, DELEGATION_NODE_ID, DIRECT_PING_PATH, directHttpsPort, isDirectAddress,
  type DirectLinkStatus, type DirectPeerStatus, type DirectPhoneStatus, type DirectRouteMode, type TailscaleInfo,
} from '@shared/delegations'
import { getSaasConfig } from '../gateway/saas/config.js'
import { getApiToken, isApiTokenAuthDisabled } from './api-token.js'
import { createDirectIngress } from './direct-ingress.js'
import { delegationTunnelToken } from './delegation-tunnel.js'
import { getMachinePeerLabel, isTrustedPeer, trustedPeerIds } from './machine-peers.js'
import { getConfirmedRemoteDeviceKeys, getRemoteE2EEMode } from './remote-e2ee.js'
import { selfNodeId } from './local-identity.js'
import { getDesktopIdentity } from './mobile/identity.js'
import { detectTailscale, publishServe, readServe, tailnetPeers, unpublishServe } from './tailscale.js'

/**
 * Direct connections between paired machines over Tailscale (see
 * `DirectLinkStatus` in shared/delegations.ts): the switch, this machine's
 * listener on its tailnet address, where the other machines listen, and which
 * route each request to another machine takes.
 *
 * One switch covers both directions: off, this machine neither listens nor
 * tries anyone directly, and everything goes through Broker as before.
 *
 * Phones: the same listener also opens on
 * 127.0.0.1 at the same port, and Tailscale Serve publishes that at
 * `https://<MagicDNS name>:<port + 1>` (`DirectPhoneStatus`). Paired phones
 * learn the address over their encrypted channel (`DIRECT_INFO_PATH`).
 */

export interface DirectLinkStorage {
  get<T = unknown>(key: string): T | undefined
  set(key: string, value: unknown): void
}

const ENABLED_KEY = 'direct:enabled'
const PORT_KEY = 'direct:port'
const ADDRESSES_KEY = 'direct:addresses'
const MODES_KEY = 'direct:modes'
const BROKER_KEY = 'broker:enabled'

/** How often the listener follows Tailscale coming up, going down, or changing address. */
const RECONCILE_MS = 60_000
const PROBE_TIMEOUT_MS = 2_500
/** A route that answered is trusted this long before it is checked again. */
const PROBE_OK_MS = 60_000
/** A route that failed is not tried again for this long (requests go through Broker). */
const PROBE_FAILED_MS = 20_000
/** How long what the tailnet's devices answered stays true. */
const DISCOVERY_MS = 30_000
const DISCOVERY_TIMEOUT_MS = 1_500
/** After Serve refused, wait this long before the background check asks it again. */
const PUBLISH_RETRY_MS = 10 * 60_000

interface PeerAddress { url: string; at: number }
interface Probe { url: string; ok: boolean; at: number; error?: string }

let storage: DirectLinkStorage | null = null
let server: http.Server | null = null
let bound: string | null = null
let listenError: string | undefined
/** The loopback side of the listener, which Tailscale Serve proxies phones to. */
let loopback: http.Server | null = null
let loopbackPort: number | null = null
/** The phone address, once Serve is seen publishing it. */
let phoneAddress: string | null = null
let phoneError: string | undefined
let publishFailedAt = 0
let tailscale: TailscaleInfo = { state: 'not_found' }
let detectedAt = 0
let timer: ReturnType<typeof setInterval> | undefined
let reconciling: Promise<void> | null = null
let addressListener: (() => void) | null = null
const probes = new Map<string, Probe>()
const probing = new Map<string, Promise<Probe>>()
/** The route the last request to each machine took, for Remote settings. */
const lastRoute = new Map<string, { route: 'direct' | 'broker'; at: number }>()

export function initDirectLink(adapter: DirectLinkStorage, options: { onAddressChange?: () => void } = {}): void {
  storage = adapter
  addressListener = options.onAddressChange ?? null
}

function enabled(): boolean {
  return storage?.get<boolean>(ENABLED_KEY) === true
}

function port(): number {
  const value = storage?.get<number>(PORT_KEY)
  // One above it is the phone address.
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65_534 ? value : DEFAULT_DIRECT_PORT
}

function addresses(): Record<string, PeerAddress> {
  return storage?.get<Record<string, PeerAddress>>(ADDRESSES_KEY) ?? {}
}

function modes(): Record<string, DirectRouteMode> {
  return storage?.get<Record<string, DirectRouteMode>>(MODES_KEY) ?? {}
}


// ── Broker, or not ─────────────────────────────────────────────────────────

/**
 * "Use Broker" (Remote settings): off, this machine does not connect to
 * Broker even while signed in, and reaches everything directly. On by default.
 */
export function brokerEnabled(): boolean {
  return storage?.get<boolean>(BROKER_KEY) !== false
}

export function setBrokerEnabled(on: boolean): void {
  requireStorage().set(BROKER_KEY, on)
  probes.clear()
}

/** Whether a request may go through Broker now: turned on, and signed in. */
export function brokerUsable(): boolean {
  return brokerEnabled() && !!getSaasConfig().nodeToken
}

function localPort(): number | null {
  const value = Number(process.env.OPERON_PORT)
  return Number.isInteger(value) && value > 0 ? value : null
}

/** Where this machine's listener can be reached, while it listens. */
export function ownDirectAddress(): string | null {
  return bound
}

/** Where paired phones reach this machine, while Tailscale Serve publishes it. */
export function ownPhoneAddress(): string | null {
  return phoneAddress
}

// ── This machine's listener ────────────────────────────────────────────────

/** Start following Tailscale; called once the server listens. */
export function startDirectLink(): () => void {
  void reconcile()
  if (!timer) {
    timer = setInterval(() => void reconcile(), RECONCILE_MS)
    timer.unref?.()
  }
  return stopDirectLink
}

export function stopDirectLink(): void {
  if (timer) clearInterval(timer)
  timer = undefined
  void closeListener()
  void closeLoopback()
  phoneAddress = null
}

/** Bring the listener in line with the switch and with Tailscale. */
export function reconcile(): Promise<void> {
  reconciling ??= (async () => {
    try {
      tailscale = await detectTailscale()
      detectedAt = Date.now()
      const want = enabled() && tailscale.state === 'running' && tailscale.ipv4 && localPort()
        ? `http://${tailscale.ipv4}:${port()}`
        : null
      if (!want) listenError = undefined
      const before = bound
      if (want !== bound || !server) {
        await closeListener()
        listenError = undefined
        if (want && tailscale.ipv4) await openListener(tailscale.ipv4, port(), want)
      }
      if (bound !== before) addressListener?.()
    } catch (error) {
      listenError = error instanceof Error ? error.message : String(error)
    }
    try {
      await reconcilePhones()
    } catch (error) {
      phoneError = error instanceof Error ? error.message : String(error)
    } finally {
      reconciling = null
    }
  })()
  return reconciling
}

function selfLabel(): string | null {
  try {
    return getSaasConfig().label || getDesktopIdentity().desktopName
  } catch {
    return null
  }
}

function ingress(): http.Server {
  return createDirectIngress({
    localPort,
    localToken: () => (isApiTokenAuthDisabled() ? undefined : getApiToken()),
    delegationTunnelToken,
    selfNodeId,
    selfLabel,
    trustedPeer: (nodeId) => (isTrustedPeer(nodeId) ? { label: getMachinePeerLabel(nodeId) } : null),
    pairedDevice: (deviceId) => getConfirmedRemoteDeviceKeys(deviceId) !== null,
    e2eeRequired: () => getRemoteE2EEMode() === 'required',
  })
}

async function openListener(host: string, listenPort: number, address: string): Promise<void> {
  const ingress_ = ingress()
  await new Promise<void>((resolve) => {
    const failed = (error: NodeJS.ErrnoException) => {
      listenError = error.code === 'EADDRINUSE'
        ? `Port ${listenPort} is in use. Pick another port.`
        : error.code === 'EADDRNOTAVAIL'
          ? 'The Tailscale address is not available yet.'
          : error.message
      resolve()
    }
    ingress_.once('error', failed)
    ingress_.listen(listenPort, host, () => {
      ingress_.off('error', failed)
      ingress_.on('error', (error) => console.error('[direct-link] listener error:', error))
      server = ingress_
      bound = address
      console.log(`[direct-link] listening on ${address}`)
      resolve()
    })
  })
}

async function closeListener(): Promise<void> {
  const closing = server
  server = null
  bound = null
  await closeServer(closing)
}

async function closeServer(closing: http.Server | null): Promise<void> {
  if (!closing) return
  await new Promise<void>((resolve) => {
    closing.close(() => resolve())
    // Open event streams would hold close() forever.
    closing.closeAllConnections?.()
  })
}

// ── Phones, through Tailscale Serve ────────────────────────────────────────

async function openLoopback(listenPort: number): Promise<void> {
  if (loopback && loopbackPort === listenPort) return
  await closeLoopback()
  const opening = ingress()
  await new Promise<void>((resolve, reject) => {
    opening.once('error', (error: NodeJS.ErrnoException) => {
      reject(new Error(error.code === 'EADDRINUSE' ? `Port ${listenPort} on 127.0.0.1 is in use. Pick another port.` : error.message))
    })
    opening.listen(listenPort, '127.0.0.1', () => {
      opening.removeAllListeners('error')
      opening.on('error', (error) => console.error('[direct-link] loopback listener error:', error))
      loopback = opening
      loopbackPort = listenPort
      resolve()
    })
  })
}

async function closeLoopback(): Promise<void> {
  const closing = loopback
  loopback = null
  loopbackPort = null
  await closeServer(closing)
}

/**
 * Bring the phone address in line with its switch: while direct connections
 * are on, Tailscale runs, and the tailnet issues certificates, keep the
 * loopback listener open and Serve publishing it. Serve keeps its entry across
 * restarts on its own; this only adds it when it is missing (after a refusal,
 * at most every PUBLISH_RETRY_MS) and reads where it points.
 */
async function reconcilePhones(): Promise<void> {
  const wanted = enabled() && tailscale.state === 'running' && !!tailscale.dnsName && !!localPort()
  if (!wanted) {
    phoneAddress = null
    if (!enabled()) phoneError = undefined
    await closeLoopback()
    return
  }
  if (!tailscale.https) {
    phoneAddress = null
    phoneError = undefined
    await closeLoopback()
    return
  }
  const listenPort = port()
  const httpsPort = directHttpsPort(listenPort)
  const target = `http://127.0.0.1:${listenPort}`
  await openLoopback(listenPort)
  let points = await readServe(httpsPort)
  if (points && points !== target) {
    phoneAddress = null
    phoneError = `Tailscale Serve port ${httpsPort} is already in use.`
    return
  }
  if (points !== target && Date.now() - publishFailedAt > PUBLISH_RETRY_MS) {
    const published = await publishServe(httpsPort, target)
    if (published.ok) {
      publishFailedAt = 0
      points = await readServe(httpsPort)
    } else {
      publishFailedAt = Date.now()
      phoneError = published.error
    }
  }
  if (points === target) {
    const address = `https://${tailscale.dnsName}:${httpsPort}`
    if (address !== phoneAddress) warmUp(address)
    phoneAddress = address
    phoneError = undefined
  } else {
    phoneAddress = null
    phoneError ??= points === undefined ? 'Tailscale Serve could not be asked on this machine.' : 'Tailscale Serve is not publishing this machine yet.'
  }
}

/**
 * Tailscale gets the certificate for a name on its first HTTPS connection,
 * which can take longer than a phone waits for its first probe. Ask once from
 * here so it is in place by then.
 */
function warmUp(address: string): void {
  void fetch(`${address}${DIRECT_PING_PATH}`, { signal: AbortSignal.timeout(60_000) }).then((r) => r.body?.cancel(), () => undefined)
}

function phoneStatus(): DirectPhoneStatus {
  const httpsPort = directHttpsPort(port())
  const live = enabled()
  return {
    enabled: live,
    httpsPort,
    ...(live && phoneAddress ? { address: phoneAddress } : {}),
    ...(live && tailscale.state === 'running' && !tailscale.https ? { needsHttps: true } : {}),
    ...(live && !phoneAddress && phoneError ? { error: phoneError } : {}),
  }
}

export async function setDirectLinkSettings(input: { enabled?: boolean; port?: number }): Promise<void> {
  const store = requireStorage()
  // Serve's entry names the old port: take it down before it points nowhere.
  const dropServe = enabled() && (
    (input.port !== undefined && input.port !== port()) || input.enabled === false
  )
  if (dropServe) {
    if (await readServe(directHttpsPort(port())) === `http://127.0.0.1:${port()}`) await unpublishServe(directHttpsPort(port()))
    phoneAddress = null
  }
  if (input.port !== undefined) store.set(PORT_KEY, input.port)
  if (input.enabled !== undefined) {
    store.set(ENABLED_KEY, input.enabled)
    if (!input.enabled) {
      probes.clear()
      lastRoute.clear()
    }
  }
  publishFailedAt = 0
  await reconcileFresh()
}

/** A reconcile that starts after this call, so it sees the setting just saved. */
async function reconcileFresh(): Promise<void> {
  await reconciling
  await reconcile()
}

function requireStorage(): DirectLinkStorage {
  if (!storage) throw new Error('direct link is not initialized')
  return storage
}

// ── The other machines ─────────────────────────────────────────────────────

/** What a trusted machine said about where it listens (`MachinePeerSync.direct`). */
export function recordPeerAddress(nodeId: string, value: unknown): void {
  if (!storage || !DELEGATION_NODE_ID.test(nodeId)) return
  const known = addresses()
  if (value === null) {
    if (!known[nodeId]) return
    delete known[nodeId]
  } else if (isDirectAddress(value)) {
    if (!isTrustedPeer(nodeId) || known[nodeId]?.url === value) return
    known[nodeId] = { url: value, at: Date.now() }
  } else {
    return
  }
  storage.set(ADDRESSES_KEY, known)
  probes.delete(nodeId)
}

export function setPeerMode(nodeId: string, mode: DirectRouteMode): void {
  const store = requireStorage()
  const next = { ...modes() }
  if (mode === 'auto') delete next[nodeId]
  else next[nodeId] = mode
  store.set(MODES_KEY, next)
  probes.delete(nodeId)
}

/** `fallback`: Broker may carry a request the direct listener turned away unread (Auto mode). */
export type MachineRoute = { kind: 'direct'; base: string; fallback: boolean } | { kind: 'broker' }

/** Thrown when a machine is set to direct only and cannot be reached that way. */
export class DirectRouteError extends Error {}

async function probe(nodeId: string, url: string): Promise<Probe> {
  const cached = probes.get(nodeId)
  if (cached && cached.url === url && Date.now() - cached.at < (cached.ok ? PROBE_OK_MS : PROBE_FAILED_MS)) return cached
  let pending = probing.get(nodeId)
  if (!pending) {
    pending = (async (): Promise<Probe> => {
      try {
        const response = await fetch(`${url}${DIRECT_PING_PATH}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'error' })
        const body = response.ok ? await response.json() as { nodeId?: unknown } : null
        if (body?.nodeId !== nodeId) return { url, ok: false, at: Date.now(), error: 'Another machine answers at that address' }
        return { url, ok: true, at: Date.now() }
      } catch {
        return { url, ok: false, at: Date.now(), error: 'Not reachable over Tailscale' }
      }
    })().then((result) => {
      probes.set(nodeId, result)
      probing.delete(nodeId)
      return result
    })
    probing.set(nodeId, pending)
  }
  return pending
}

/** Which way the next request to `nodeId` goes. */
export async function routeTo(nodeId: string): Promise<MachineRoute> {
  const chosen = modes()[nodeId] ?? 'auto'
  // Without Broker there is only the direct route.
  const mode: DirectRouteMode = brokerUsable() ? chosen : 'direct'
  if (mode === 'broker') return { kind: 'broker' }
  if (!enabled()) {
    if (mode === 'direct') {
      throw new DirectRouteError(brokerUsable()
        ? 'Turn on direct connections in Settings → Remote first'
        : 'This machine does not use Broker. Turn on direct connections in Settings → Remote.')
    }
    return { kind: 'broker' }
  }
  const address = addresses()[nodeId]
  if (!address) {
    if (mode === 'direct') throw new DirectRouteError('That machine has not shared a direct address yet. Turn on direct connections there too.')
    return { kind: 'broker' }
  }
  const result = await probe(nodeId, address.url)
  if (result.ok) return { kind: 'direct', base: address.url, fallback: mode === 'auto' }
  if (mode === 'direct') throw new DirectRouteError(`${result.error ?? 'Not reachable over Tailscale'}. Check that Tailscale is on, on both machines.`)
  return { kind: 'broker' }
}

/** A direct request failed or was turned away: route through Broker until it answers again. */
export function markDirectFailed(nodeId: string, base: string, error = 'The direct connection dropped'): void {
  probes.set(nodeId, { url: base, ok: false, at: Date.now(), error })
}

// ── Finding machines on the tailnet ────────────────────────────────────────

export interface DiscoveredMachine {
  nodeId: string
  label?: string
  address: string
}

let discovered: { at: number; machines: DiscoveredMachine[] } | null = null
let discovering: Promise<DiscoveredMachine[]> | null = null

/**
 * The tailnet's devices that answer the direct ping: machines running Operon
 * with direct connections on, whoever's they are pairing-wise. How a machine
 * without Broker finds the others to pair with, and how it learns where a
 * paired one listens before their first sync. Only the ports this machine
 * could expect: its own, and the default.
 */
export async function discoverMachines(options: { fresh?: boolean } = {}): Promise<DiscoveredMachine[]> {
  if (!enabled()) return []
  if (!options.fresh && discovered && Date.now() - discovered.at < DISCOVERY_MS) return discovered.machines
  discovering ??= (async () => {
    if (Date.now() - detectedAt > DISCOVERY_MS) await reconcileFresh()
    const self = selfNodeId()
    const ports = [...new Set([port(), DEFAULT_DIRECT_PORT])]
    const candidates = tailnetPeers().flatMap((peer) => ports.map((p) => `http://${peer.ipv4}:${p}`))
    const answers = await Promise.all(candidates.map(async (address): Promise<DiscoveredMachine | null> => {
      try {
        const response = await fetch(`${address}${DIRECT_PING_PATH}`, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), redirect: 'error' })
        if (!response.ok) return null
        const body = await response.json() as { nodeId?: unknown; label?: unknown }
        if (typeof body.nodeId !== 'string' || !DELEGATION_NODE_ID.test(body.nodeId) || body.nodeId === self) return null
        const label = typeof body.label === 'string' ? body.label.slice(0, 120) : undefined
        return { nodeId: body.nodeId, address, ...(label ? { label } : {}) }
      } catch {
        return null
      }
    }))
    const byNode = new Map<string, DiscoveredMachine>()
    for (const machine of answers) if (machine && !byNode.has(machine.nodeId)) byNode.set(machine.nodeId, machine)
    const machines = [...byNode.values()]
    // A paired machine answering here is where it listens, sync or not.
    for (const machine of machines) {
      if (isTrustedPeer(machine.nodeId)) {
        recordPeerAddress(machine.nodeId, machine.address)
        probes.set(machine.nodeId, { url: machine.address, ok: true, at: Date.now() })
      }
    }
    discovered = { at: Date.now(), machines }
    return machines
  })().finally(() => { discovering = null })
  return discovering
}

/** Where a machine was found on the tailnet, if it was. */
export function discoveredAddress(nodeId: string): string | null {
  return discovered?.machines.find((machine) => machine.nodeId === nodeId)?.address ?? null
}

export function noteRoute(nodeId: string, route: 'direct' | 'broker'): void {
  lastRoute.set(nodeId, { route, at: Date.now() })
}

export async function getDirectLinkStatus(options: { probe?: boolean } = {}): Promise<DirectLinkStatus> {
  // Settings is where someone who just signed in to Tailscale looks next.
  if (Date.now() - detectedAt > 10_000) await reconcile()
  const known = addresses()
  const chosen = modes()
  const peers: DirectPeerStatus[] = await Promise.all(trustedPeerIds().map(async (nodeId): Promise<DirectPeerStatus> => {
    const address = known[nodeId]?.url
    const mode = chosen[nodeId] ?? 'auto'
    let check = probes.get(nodeId)
    if (options.probe && enabled() && address && mode !== 'broker') check = await probe(nodeId, address)
    const last = lastRoute.get(nodeId)
    const route: DirectPeerStatus['route'] = !brokerUsable() ? (check?.ok && check.url === address ? 'direct' : 'unknown')
      : mode === 'broker' || !enabled() ? 'broker'
      : check ? (check.ok && check.url === address ? 'direct' : 'broker')
        : last?.route ?? 'unknown'
    return {
      nodeId,
      ...(address ? { address } : {}),
      mode,
      route,
      ...(check ? { checkedAt: check.at } : {}),
      ...(check && !check.ok && check.error ? { error: check.error } : {}),
    }
  }))
  return {
    enabled: enabled(),
    port: port(),
    tailscale,
    ...(bound ? { address: bound } : {}),
    ...(enabled() && !bound ? { error: listenError ?? notListeningReason(tailscale) } : {}),
    peers,
    phones: phoneStatus(),
    broker: { enabled: brokerEnabled(), signedIn: !!getSaasConfig().nodeToken },
  }
}

function notListeningReason(info: TailscaleInfo): string {
  switch (info.state) {
    case 'not_found': return 'Tailscale is not installed on this machine.'
    case 'needs_login': return 'Sign in to Tailscale on this machine.'
    case 'stopped': return 'Tailscale is not connected on this machine.'
    default: return 'Starting…'
  }
}

export const directLinkTestUtils = {
  reset(): void {
    stopDirectLink()
    storage = null
    addressListener = null
    listenError = undefined
    phoneError = undefined
    publishFailedAt = 0
    tailscale = { state: 'not_found' }
    detectedAt = 0
    probes.clear()
    probing.clear()
    lastRoute.clear()
    discovered = null
    discovering = null
  },
  setTailscale(info: TailscaleInfo): void {
    tailscale = info
    detectedAt = Date.now()
  },
}
