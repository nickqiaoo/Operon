import { BROKER_URL } from '../gateway/saas/broker.js'
import { getSaasConfig } from '../gateway/saas/config.js'
import crypto from 'node:crypto'
import { DELEGATION_NODE_ID, MACHINE_PAIR_CLAIM_PATH, type DelegationMachine } from '@shared/delegations'
import { deriveDelegationKeys, open, seal, type RemoteDirectionKeys } from '@shared/e2ee/crypto'
import {
  E2EE_CONTEXT_HEADER, E2EE_DEVICE_HEADER, E2EE_FRAMING_HEADER, E2EE_HEADER, E2EE_INNER_CONTENT_TYPE_HEADER,
  E2EE_KEY_HEADER, E2EE_PROOF_HEADER, E2EE_TIME_HEADER, REMOTE_E2EE_VERSION, WEBSOCKET_NONCE_PARAM, WEBSOCKET_TIME_PARAM,
  decodeStreamFrame, requestAad, responseContext, responseFrameAad, utf8, webSocketSession,
} from '@shared/e2ee/protocol'
import { getDelegationKeypair } from './mobile/identity.js'
import {
  DirectRouteError, brokerUsable, discoverMachines, discoveredAddress, markDirectFailed, noteRoute, routeTo, type MachineRoute,
} from './direct-link.js'
import { getMachinePeerLabel, isTrustedPeer, trustedPeerIds, trustedPeerKey } from './machine-peers.js'
import { getDesktopIdentity } from './mobile/identity.js'
import { selfNodeId } from './local-identity.js'

/**
 * Machine-to-machine requests, through Broker or directly over Tailscale
 * (direct-link.ts). Broker authenticates both machines by their node tokens and
 * routes between them, but is not trusted with keys: each request is sealed
 * with keys derived from the other machine's delegation key as pinned when the
 * two paired (machine-peers.ts). A direct request is sealed the same way, so
 * which route carries it changes nothing about who can read or forge it. A
 * machine not paired with this one cannot be reached.
 */

export class DelegationHttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message) }
}

const REQUEST_TIMEOUT_MS = 40_000
/** Broker and the direct listener send an SSE keepalive every 15s; a stream silent for this long is dead. */
const STREAM_IDLE_MS = 60_000

function localNode() {
  const config = getSaasConfig()
  if (!config.nodeToken || !config.nodeId || !config.userId) throw new DelegationHttpError(503, 'Connect this machine in Remote settings first')
  return { nodeToken: config.nodeToken, nodeId: config.nodeId, userId: config.userId }
}

async function chooseRoute(target: string): Promise<MachineRoute> {
  try {
    return await routeTo(target)
  } catch (error) {
    if (error instanceof DirectRouteError) throw new DelegationHttpError(503, error.message, 'direct_unreachable')
    throw error
  }
}

/**
 * Refusals the direct listener gives before anything reaches the server
 * (direct-ingress.ts), so the same sealed request may still go through Broker.
 */
const DIRECT_TURNED_AWAY = new Set(['direct_unavailable', 'starting'])

async function turnedAway(response: Response): Promise<string | null> {
  if (response.status !== 503 || response.headers.get(E2EE_HEADER)) return null
  try {
    const body = await response.clone().json() as { error?: unknown; message?: unknown }
    if (typeof body.error !== 'string' || !DIRECT_TURNED_AWAY.has(body.error)) return null
    return typeof body.message === 'string' ? body.message : body.error
  } catch {
    return null
  }
}

/**
 * `apiPath` on machine `target`, directly when that machine is reachable over
 * Tailscale (and not set to Broker only), otherwise through Broker. A direct
 * request that cannot connect is not retried through Broker: it may have
 * arrived, and a sealed request is accepted once. The next one goes through
 * Broker until the direct route answers again. One the direct listener turned
 * away unread (E2EE off there, still starting) does go through Broker in Auto.
 * `direct` is the base a direct answer came from.
 */
async function machineFetch(
  target: string, apiPath: string, init: RequestInit & { signal: AbortSignal }, opening?: AbortSignal,
): Promise<{ response: Response; direct?: string }> {
  const route = await chooseRoute(target)
  if (route.kind === 'direct') {
    let response: Response
    try {
      response = await fetch(`${route.base}${apiPath}`, { ...init, redirect: 'error' })
    } catch (error) {
      // Our own caller giving up says nothing about the route; no answer in time does.
      if (init.signal.aborted && !opening?.aborted) throw error
      markDirectFailed(target, route.base)
      if (init.signal.aborted) throw error
      throw new DelegationHttpError(503, 'The direct connection to the machine failed', 'node_unreachable')
    }
    const refusal = await turnedAway(response)
    if (refusal === null) {
      noteRoute(target, 'direct')
      return { response, direct: route.base }
    }
    markDirectFailed(target, route.base, refusal)
    if (!route.fallback) return { response }
    void response.body?.cancel().catch(() => undefined)
  }
  const { userId, nodeToken } = localNode()
  const response = await brokerFetch(nodeToken, `/u/${encodeURIComponent(userId)}/n/${target}${apiPath}`, init)
  noteRoute(target, 'broker')
  return { response }
}

async function brokerFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  try {
    return await fetch(`${BROKER_URL}${path}`, { ...init, headers, redirect: 'error' })
  } catch (error) {
    if (init?.signal?.aborted) throw error
    throw new DelegationHttpError(503, 'Could not reach the machine through Broker', 'node_unreachable')
  }
}

function errorFromBody(status: number, text: string): DelegationHttpError {
  let body: { error?: string; message?: string } | undefined
  try { body = JSON.parse(text) } catch { /* broker or proxy error */ }
  const code = body?.error
  return new DelegationHttpError(status, body?.message ?? code ?? `Remote request failed (HTTP ${status})`, code)
}

async function readText(response: Response): Promise<string> {
  try { return await response.text() }
  catch { throw new DelegationHttpError(503, 'The response from the machine was interrupted', 'node_unreachable') }
}

/**
 * The machines this one can see: the account's, from Broker (while it uses
 * Broker), and the tailnet's devices that answer the direct ping, merged with
 * the ones paired with this machine. A paired machine nobody reports is listed
 * offline.
 */
export async function listDelegationNodes(): Promise<DelegationMachine[]> {
  const self = selfNodeId()
  const byId = new Map<string, Omit<DelegationMachine, 'current' | 'paired'>>()
  const [fromBroker, onTailnet] = await Promise.all([
    brokerUsable() ? brokerMachines().catch((error: unknown) => error) : Promise.resolve([]),
    discoverMachines().catch(() => []),
  ])
  if (fromBroker instanceof Error) {
    // Broker was the only way to see anyone: say why the list is empty.
    if (!onTailnet.length) throw fromBroker
  } else {
    for (const node of fromBroker as Array<Omit<DelegationMachine, 'current'>>) byId.set(node.nodeId, { nodeId: node.nodeId, label: node.label, online: node.online })
  }
  for (const machine of onTailnet) {
    const known = byId.get(machine.nodeId)
    byId.set(machine.nodeId, {
      nodeId: machine.nodeId,
      label: known?.label || getMachinePeerLabel(machine.nodeId) || machine.label || machine.nodeId.slice(0, 8),
      online: true,
    })
  }
  for (const nodeId of trustedPeerIds()) {
    if (!byId.has(nodeId)) byId.set(nodeId, { nodeId, label: getMachinePeerLabel(nodeId) || nodeId.slice(0, 8), online: false })
  }
  if (!byId.has(self)) {
    byId.set(self, { nodeId: self, label: getSaasConfig().label || getDesktopIdentity().desktopName, online: true })
  }
  return [...byId.values()].map((node) => ({
    ...node, current: node.nodeId === self,
    ...(node.nodeId === self ? {} : { paired: isTrustedPeer(node.nodeId) }),
  }))
}

async function brokerMachines(): Promise<Array<Omit<DelegationMachine, 'current'>>> {
  const { nodeToken } = localNode()
  const response = await brokerFetch(nodeToken, '/agent/delegation-nodes', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const text = await readText(response)
  if (!response.ok) throw errorFromBody(response.status, text)
  return JSON.parse(text) as Array<Omit<DelegationMachine, 'current'>>
}

/** Keyed by the pinned key too, so re-pairing with a new key is picked up at once. */
const peerKeys = new Map<string, RemoteDirectionKeys>()

function keysFor(target: string, nodeId: string): RemoteDirectionKeys {
  const peer = trustedPeerKey(target)
  if (!peer) {
    throw new DelegationHttpError(403, 'This machine is not paired with that one. Pair them in Settings → Remote first.', 'machine_not_paired')
  }
  const cacheKey = `${target}:${peer.fingerprint}`
  let keys = peerKeys.get(cacheKey)
  if (!keys) {
    keys = deriveDelegationKeys(getDelegationKeypair().privateKey, peer.publicKey, nodeId, target)
    peerKeys.set(cacheKey, keys)
  }
  return keys
}

/**
 * The one request between machines that is not sealed by this transport: a
 * pairing claim, made before the two share a key. Its body carries its own
 * envelope, sealed under the pairing code.
 */
export async function pairingClaimRequest<T>(target: string, body: unknown): Promise<{ status: number; body: T | null }> {
  const self = selfNodeId()
  if (!DELEGATION_NODE_ID.test(target) || self === target) throw new DelegationHttpError(400, 'Select another machine')
  const init = {
    method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }
  // A machine found on the tailnet is asked there: it may not use Broker, and
  // the claim is sealed under the code either way. Its listener stamps who is
  // claiming from this header, as Broker stamps it from the node token.
  const direct = discoveredAddress(target)
  let response: Response
  if (direct) {
    try {
      response = await fetch(`${direct}${MACHINE_PAIR_CLAIM_PATH}`, {
        ...init, redirect: 'error', headers: { 'Content-Type': 'application/json', [E2EE_DEVICE_HEADER]: self },
      })
    } catch {
      throw new DelegationHttpError(503, 'Could not reach the machine over Tailscale', 'node_unreachable')
    }
  } else {
    const { userId, nodeToken } = localNode()
    response = await brokerFetch(nodeToken, `/u/${encodeURIComponent(userId)}/n/${target}${MACHINE_PAIR_CLAIM_PATH}`, {
      ...init, headers: { 'Content-Type': 'application/json' },
    })
  }
  const text = await readText(response)
  let parsed: T | null = null
  try { parsed = JSON.parse(text) as T } catch { /* broker or proxy error */ }
  return { status: response.status, body: parsed }
}

interface OpenedResponse {
  response: Response
  /** The content type the other machine's route answered with. */
  innerType: string
  /** Decrypted body, in the order it was sent. */
  chunks: AsyncGenerator<Uint8Array>
}

interface SendOptions {
  method: string
  /** Path and query on the other machine, e.g. `/api/fs/read?path=…`. */
  apiPath: string
  body?: Uint8Array | string
  contentType?: string
  signal?: AbortSignal
  /** How long to wait for the response head. */
  openTimeoutMs?: number
  /**
   * How long a non-SSE body may stay silent. SSE gets keepalives every 15s
   * (from Broker, or from the other machine's direct listener), so it always
   * uses the short limit.
   */
  bodyIdleMs?: number
}

async function send(target: string, options: SendOptions): Promise<OpenedResponse> {
  const deviceId = selfNodeId()
  if (!DELEGATION_NODE_ID.test(target) || deviceId === target) throw new DelegationHttpError(400, 'Select another machine')
  const keys = keysFor(target, deviceId)
  const keyId = getDelegationKeypair().fingerprint
  const method = options.method.toUpperCase()
  const { apiPath } = options
  // GET and HEAD carry the sealed (empty) body in a header; everything else in the body,
  // even when empty — the receiving machine opens a body for every other method.
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const innerContentType = hasBody ? options.contentType ?? '' : ''
  const plaintext = typeof options.body === 'string' ? utf8(options.body) : options.body ?? new Uint8Array()
  const time = Date.now()
  const envelope = seal(hasBody ? plaintext : new Uint8Array(), keys.request, requestAad({ method, apiPath, deviceId, keyId, innerContentType, time }))
  const context = responseContext({ method, apiPath, requestNonce: envelope.nonce })
  const headers = new Headers({ [E2EE_HEADER]: REMOTE_E2EE_VERSION, [E2EE_DEVICE_HEADER]: deviceId, [E2EE_KEY_HEADER]: keyId,
    [E2EE_INNER_CONTENT_TYPE_HEADER]: innerContentType, [E2EE_TIME_HEADER]: String(time) })
  const payload = JSON.stringify(envelope)
  if (hasBody) headers.set('Content-Type', 'application/json')
  else headers.set(E2EE_PROOF_HEADER, payload)

  // The timeout covers getting an answer; a stream then stays open as long as it is alive.
  const opening = AbortSignal.timeout(options.openTimeoutMs ?? REQUEST_TIMEOUT_MS)
  const { response, direct } = await machineFetch(target, apiPath, {
    method, headers, body: hasBody ? payload : undefined,
    signal: options.signal ? AbortSignal.any([options.signal, opening]) : opening,
  }, opening)
  if (response.headers.get(E2EE_HEADER) !== REMOTE_E2EE_VERSION) {
    const text = await readText(response)
    throw response.ok ? new DelegationHttpError(502, 'The machine returned an unencrypted response') : errorFromBody(response.status, text)
  }
  const framing = response.headers.get(E2EE_FRAMING_HEADER)
  if (response.headers.get(E2EE_CONTEXT_HEADER) !== context || (framing !== 'ndjson' && framing !== 'sse') || !response.body) {
    throw new DelegationHttpError(502, 'Invalid encrypted response')
  }
  const innerType = response.headers.get(E2EE_INNER_CONTENT_TYPE_HEADER) ?? ''
  const aad = (seq: number, final: boolean) => responseFrameAad({
    deviceId, keyId, context, status: response.status, framing, innerContentType: innerType, seq, final,
  })
  const chunks = decryptFrames(response.body, framing, keys.response, aad,
    framing === 'sse' ? STREAM_IDLE_MS : options.bodyIdleMs ?? STREAM_IDLE_MS)
  return { response, innerType, chunks: direct ? watchDirect(chunks, target, direct, options.signal) : chunks }
}

/**
 * A direct stream that drops or goes silent midway says the route is gone:
 * the next request goes through Broker until it answers again. Our own caller
 * hanging up says nothing about it.
 */
async function* watchDirect(
  chunks: AsyncGenerator<Uint8Array>, target: string, base: string, signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  try {
    yield* chunks
  } catch (error) {
    if (!signal?.aborted && error instanceof DelegationHttpError && error.code === 'node_unreachable') {
      markDirectFailed(target, base)
    }
    throw error
  }
}

async function* decryptFrames(
  body: ReadableStream<Uint8Array>, framing: 'ndjson' | 'sse', key: Uint8Array, aad: (seq: number, final: boolean) => Uint8Array,
  idleMs: number,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let seq = 0
  let idle: ReturnType<typeof setTimeout> | undefined
  const read = () => new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
    idle = setTimeout(() => reject(new DelegationHttpError(504, 'The machine stopped responding', 'node_unreachable')), idleMs)
    reader.read().then(resolve, () => reject(new DelegationHttpError(503, 'The connection to the machine was lost', 'node_unreachable')))
  }).finally(() => clearTimeout(idle))
  const take = (): string | null => {
    if (framing === 'ndjson') {
      const end = buffer.indexOf('\n')
      if (end < 0) return null
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      return line || take()
    }
    const end = buffer.indexOf('\n\n')
    if (end < 0) return null
    const block = buffer.slice(0, end)
    buffer = buffer.slice(end + 2)
    // Keepalives (Broker's, or the direct listener's) are comment lines with no data.
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
    return data || take()
  }
  try {
    for (;;) {
      const record = take()
      if (record !== null) {
        const frame = decodeStreamFrame(record)
        if (frame.seq !== seq) throw new DelegationHttpError(502, 'Invalid encrypted response sequence')
        const plaintext = open(frame, key, aad(seq, frame.final))
        seq += 1
        if (plaintext.length) yield plaintext
        if (frame.final) return
        continue
      }
      const { value, done } = await read()
      if (done) throw new DelegationHttpError(503, 'The connection to the machine was lost', 'node_unreachable')
      buffer += decoder.decode(value, { stream: true })
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

/** A JSON request to another machine. */
export async function delegationRequest<T>(target: string, apiPath: string, body?: unknown): Promise<T> {
  const { response, chunks } = await send(target, {
    method: body === undefined ? 'GET' : 'POST', apiPath, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), contentType: 'application/json' }),
  })
  const parts: Uint8Array[] = []
  for await (const chunk of chunks) parts.push(chunk)
  const text = Buffer.concat(parts).toString('utf8')
  if (!response.ok) throw errorFromBody(response.status, text)
  return JSON.parse(text) as T
}

/** Routes that take long before answering (a push, a commit hook, a generated message). */
const RELAY_OPEN_TIMEOUT_MS = 5 * 60_000
const RELAY_BODY_IDLE_MS = 5 * 60_000

/** Response headers that describe the encrypted hop, not the route's answer. */
const HOP_HEADERS = new Set([
  E2EE_HEADER, E2EE_CONTEXT_HEADER, E2EE_FRAMING_HEADER, E2EE_INNER_CONTENT_TYPE_HEADER,
  'content-type', 'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'cache-control',
].map((name) => name.toLowerCase()))

/**
 * Replays one of this machine's own API requests on another machine of the
 * account: the same method, path, query and body, end-to-end encrypted (through
 * Broker or directly), answered with the other machine's response (streams stay streams).
 */
export async function relayRequest(target: string, apiPath: string, request: Request): Promise<Response> {
  const method = request.method.toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD'
  // Cancelling the relayed body must also drop the request to the machine: a read
  // pending on a quiet event stream would otherwise wait for its next event.
  const stop = new AbortController()
  const { response, innerType, chunks } = await send(target, {
    method, apiPath,
    body: hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined,
    contentType: request.headers.get('content-type') ?? '',
    signal: AbortSignal.any([request.signal, stop.signal]),
    openTimeoutMs: RELAY_OPEN_TIMEOUT_MS,
    bodyIdleMs: RELAY_BODY_IDLE_MS,
  })
  const headers = new Headers()
  response.headers.forEach((value, name) => {
    const key = name.toLowerCase()
    if (!HOP_HEADERS.has(key) && !key.startsWith('access-control-')) headers.append(name, value)
  })
  if (innerType) headers.set('content-type', innerType)
  headers.set('cache-control', 'no-store')
  if (response.status === 204 || response.status === 304 || method === 'HEAD') {
    void drain(chunks)
    return new Response(null, { status: response.status, headers })
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel() {
      stop.abort()
      void chunks.return(undefined)
    },
  })
  return new Response(body, { status: response.status, headers })
}

async function drain(chunks: AsyncGenerator<Uint8Array>): Promise<void> {
  try { for await (const _ of chunks) { /* discard */ } } catch { /* nothing to deliver */ }
}

/**
 * How to open a WebSocket on another machine (its terminal): its direct
 * address, or the Broker URL with the node-token subprotocol Broker
 * authenticates; this machine's delegation identity; and the keys each frame
 * is sealed with.
 */
export async function delegationSocket(target: string, apiPath: string): Promise<{
  url: string
  /** Only through Broker, which reads its token from it. */
  protocol?: string
  deviceId: string
  keyId: string
  keys: RemoteDirectionKeys
  /** Bound into every frame's AAD (`webSocketFrameAad`). */
  session: string
}> {
  const deviceId = selfNodeId()
  if (!DELEGATION_NODE_ID.test(target) || deviceId === target) throw new DelegationHttpError(400, 'Select another machine')
  const keys = keysFor(target, deviceId)
  const keyId = getDelegationKeypair().fingerprint
  const time = Date.now()
  const nonce = crypto.randomBytes(16).toString('base64url')
  const route = await chooseRoute(target)
  let url: URL
  let protocol: string | undefined
  if (route.kind === 'direct') {
    url = new URL(`${route.base.replace(/^http/, 'ws')}${apiPath}`)
  } else {
    const { userId, nodeToken } = localNode()
    url = new URL(`${BROKER_URL.replace(/^http/, 'ws')}/u/${encodeURIComponent(userId)}/n/${target}${apiPath}`)
    protocol = `operon.bearer.${nodeToken}`
  }
  noteRoute(target, route.kind)
  url.searchParams.set('e2ee', REMOTE_E2EE_VERSION)
  url.searchParams.set('deviceId', deviceId)
  url.searchParams.set('keyId', keyId)
  url.searchParams.set(WEBSOCKET_TIME_PARAM, String(time))
  url.searchParams.set(WEBSOCKET_NONCE_PARAM, nonce)
  return { url: url.toString(), ...(protocol ? { protocol } : {}), deviceId, keyId, keys, session: webSocketSession(time, nonce) }
}
