import { BROKER_URL } from '../gateway/saas/broker.js'
import { getSaasConfig } from '../gateway/saas/config.js'
import { DELEGATION_NODE_ID, type DelegationMachine } from '@shared/delegations'
import { deriveDelegationKeys, open, seal, type RemoteDirectionKeys } from '@shared/e2ee/crypto'
import {
  E2EE_CONTEXT_HEADER, E2EE_DEVICE_HEADER, E2EE_FRAMING_HEADER, E2EE_HEADER, E2EE_INNER_CONTENT_TYPE_HEADER,
  E2EE_KEY_HEADER, E2EE_PROOF_HEADER, REMOTE_E2EE_VERSION,
  base64ToBytes, decodeStreamFrame, requestAad, responseContext, responseFrameAad, utf8,
} from '@shared/e2ee/protocol'
import { getDelegationKeypair } from './mobile/identity.js'

/**
 * Machine-to-machine requests through Broker. Broker is the trust anchor: it
 * authenticates both machines by their node tokens and hands each the other's
 * registered delegation key, which then encrypts the request and the response.
 */

export class DelegationHttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message) }
}

const REQUEST_TIMEOUT_MS = 40_000
/** Broker sends an SSE keepalive every 15s; a stream silent for this long is dead. */
const STREAM_IDLE_MS = 60_000
const PEER_KEY_TTL_MS = 10 * 60_000

function localNode() {
  const config = getSaasConfig()
  if (!config.nodeToken || !config.nodeId || !config.userId) throw new DelegationHttpError(503, 'Connect this machine in Remote settings first')
  return { nodeToken: config.nodeToken, nodeId: config.nodeId, userId: config.userId }
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

export async function listDelegationNodes(): Promise<DelegationMachine[]> {
  const { nodeId, nodeToken } = localNode()
  const response = await brokerFetch(nodeToken, '/agent/delegation-nodes', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const text = await readText(response)
  if (!response.ok) throw errorFromBody(response.status, text)
  const nodes = JSON.parse(text) as Array<Omit<DelegationMachine, 'current'>>
  return nodes.map((node) => ({ nodeId: node.nodeId, label: node.label, online: node.online, current: node.nodeId === nodeId }))
}

// A peer's key changes only when that machine reinstalls; refetching it on every
// request doubled the Broker round trips of each call.
const peerKeys = new Map<string, { keys: RemoteDirectionKeys; at: number }>()

async function keysFor(target: string): Promise<RemoteDirectionKeys> {
  const cached = peerKeys.get(target)
  if (cached && Date.now() - cached.at < PEER_KEY_TTL_MS) return cached.keys
  const { nodeId, nodeToken } = localNode()
  const response = await brokerFetch(nodeToken, `/agent/delegation-nodes?nodeId=${target}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const text = await readText(response)
  if (!response.ok) throw errorFromBody(response.status, text)
  const peer = base64ToBytes((JSON.parse(text) as { publicKey?: string }).publicKey ?? '')
  if (peer.length !== 32) throw new DelegationHttpError(502, 'Broker returned an invalid delegation public key')
  const keys = deriveDelegationKeys(getDelegationKeypair().privateKey, peer, nodeId, target)
  peerKeys.set(target, { keys, at: Date.now() })
  return keys
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
   * How long a non-SSE body may stay silent. SSE gets Broker keepalives every
   * 15s, so it always uses the short limit.
   */
  bodyIdleMs?: number
}

async function send(target: string, options: SendOptions): Promise<OpenedResponse> {
  const { userId, nodeId: deviceId, nodeToken } = localNode()
  if (!DELEGATION_NODE_ID.test(target) || deviceId === target) throw new DelegationHttpError(400, 'Select another machine')
  const keys = await keysFor(target)
  const keyId = getDelegationKeypair().fingerprint
  const method = options.method.toUpperCase()
  const { apiPath } = options
  // GET and HEAD carry the sealed (empty) body in a header; everything else in the body,
  // even when empty — the receiving machine opens a body for every other method.
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const innerContentType = hasBody ? options.contentType ?? '' : ''
  const plaintext = typeof options.body === 'string' ? utf8(options.body) : options.body ?? new Uint8Array()
  const envelope = seal(hasBody ? plaintext : new Uint8Array(), keys.request, requestAad({ method, apiPath, deviceId, keyId, innerContentType }))
  const context = responseContext({ method, apiPath, requestNonce: envelope.nonce })
  const headers = new Headers({ [E2EE_HEADER]: REMOTE_E2EE_VERSION, [E2EE_DEVICE_HEADER]: deviceId, [E2EE_KEY_HEADER]: keyId,
    [E2EE_INNER_CONTENT_TYPE_HEADER]: innerContentType })
  const payload = JSON.stringify(envelope)
  if (hasBody) headers.set('Content-Type', 'application/json')
  else headers.set(E2EE_PROOF_HEADER, payload)

  // The timeout covers getting an answer; a stream then stays open as long as it is alive.
  const opening = AbortSignal.timeout(options.openTimeoutMs ?? REQUEST_TIMEOUT_MS)
  const response = await brokerFetch(nodeToken, `/u/${encodeURIComponent(userId)}/n/${target}${apiPath}`, {
    method, headers, body: hasBody ? payload : undefined,
    signal: options.signal ? AbortSignal.any([options.signal, opening]) : opening,
  })
  if (response.headers.get(E2EE_HEADER) !== REMOTE_E2EE_VERSION) {
    const text = await readText(response)
    if (response.status === 403 && text.includes('e2ee_')) peerKeys.delete(target)
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
  return { response, innerType, chunks: decryptFrames(response.body, framing, keys.response, aad,
    framing === 'sse' ? STREAM_IDLE_MS : options.bodyIdleMs ?? STREAM_IDLE_MS) }
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
    // Broker's keepalives are comment lines with no data.
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

/** A request answered with an SSE stream; yields each event's data. */
export async function* delegationStream(target: string, apiPath: string, body: string, signal: AbortSignal): AsyncGenerator<string> {
  const { response, chunks } = await send(target, { method: 'POST', apiPath, body, contentType: 'application/json', signal })
  const decoder = new TextDecoder()
  if (!response.ok) {
    let text = ''
    for await (const chunk of chunks) text += decoder.decode(chunk, { stream: true })
    throw errorFromBody(response.status, text)
  }
  let buffer = ''
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true })
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
      if (data) yield data
    }
  }
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
 * account: the same method, path, query and body, end-to-end encrypted through
 * Broker, answered with the other machine's response (streams stay streams).
 */
export async function relayRequest(target: string, apiPath: string, request: Request): Promise<Response> {
  const method = request.method.toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD'
  // Cancelling the relayed body must also drop the Broker request: a read
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
 * How to open a WebSocket on another machine (its terminal): the Broker URL with
 * this machine's delegation identity, the node-token subprotocol Broker
 * authenticates, and the keys each frame is sealed with.
 */
export async function delegationSocket(target: string, apiPath: string): Promise<{
  url: string
  protocol: string
  deviceId: string
  keyId: string
  keys: RemoteDirectionKeys
}> {
  const { userId, nodeId: deviceId, nodeToken } = localNode()
  if (!DELEGATION_NODE_ID.test(target) || deviceId === target) throw new DelegationHttpError(400, 'Select another machine')
  const keys = await keysFor(target)
  const keyId = getDelegationKeypair().fingerprint
  const url = new URL(`${BROKER_URL.replace(/^http/, 'ws')}/u/${encodeURIComponent(userId)}/n/${target}${apiPath}`)
  url.searchParams.set('e2ee', REMOTE_E2EE_VERSION)
  url.searchParams.set('deviceId', deviceId)
  url.searchParams.set('keyId', keyId)
  return { url: url.toString(), protocol: `operon.bearer.${nodeToken}`, deviceId, keyId, keys }
}
