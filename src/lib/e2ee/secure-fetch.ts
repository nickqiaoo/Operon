import {
  E2EE_DEVICE_HEADER,
  E2EE_CONTEXT_HEADER,
  E2EE_FRAMING_HEADER,
  E2EE_HEADER,
  E2EE_INNER_CONTENT_TYPE_HEADER,
  E2EE_KEY_HEADER,
  E2EE_PROOF_HEADER,
  PAIRING_HEADER,
  REMOTE_E2EE_VERSION,
  apiPathFromBrokerUrl,
  decodeStreamFrame,
  encodeEnvelope,
  requestAad,
  responseFrameAad,
  responseContext,
} from '@shared/e2ee/protocol'
import { deriveRemoteDirectionKeys, open, seal } from '@shared/e2ee/crypto'
import { getRemotePairing, removeRemotePairing } from './device-store'
import { DIRECT_TURNED_AWAY, DirectRouteError, isDirectOnlyUrl, markDirectFailed, noteRoute, routeFor, type ClientRoute } from '../remote-route'

const encoder = new TextEncoder()
export const E2EE_PAIRING_REQUIRED_EVENT = 'operon:e2ee-pairing-required'

export async function secureBrokerFetch(
  fetchImpl: typeof window.fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init)
  const remote = parseRemoteApiUrl(request.url)
  if (!remote || request.headers.has(PAIRING_HEADER)) return fetchImpl(request)
  const pairing = await getRemotePairing(remote.nodeId)
  if (!pairing) {
    // Without an account there is nowhere to ask but the machine, and no key to ask it with.
    if (isDirectOnlyUrl(request.url)) {
      window.dispatchEvent(new CustomEvent(E2EE_PAIRING_REQUIRED_EVENT, { detail: { nodeId: remote.nodeId } }))
      return Response.json({ error: 'e2ee_required', message: 'Pair this device with the machine first' }, { status: 426 })
    }
    return unpairedFetch(fetchImpl, request, remote.nodeId)
  }
  // Directly over Tailscale when the machine shared an address that answers
  // (remote-route.ts); sealed the same either way.
  let route: ClientRoute
  try {
    route = await routeFor(fetchImpl, remote.nodeId)
  } catch (error) {
    if (error instanceof DirectRouteError) return Response.json({ error: 'direct_unreachable', message: error.message }, { status: 503 })
    throw error
  }
  // To send again through Broker, should the direct route turn out not to work.
  const retry = route.kind === 'direct' && route.fallback ? request.clone() : null
  const keys = deriveRemoteDirectionKeys(pairing)
  const headers = new Headers(request.headers)
  const method = request.method.toUpperCase()
  const apiPath = apiPathFromBrokerUrl(request.url)
  const innerContentType = headers.get('content-type') ?? ''
  const aad = requestAad({
    method,
    apiPath,
    deviceId: pairing.deviceId,
    keyId: pairing.keyId,
    innerContentType,
  })
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const plaintext = hasBody ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array()
  const envelope = seal(plaintext, keys.request, aad)
  const context = responseContext({ method, apiPath, requestNonce: envelope.nonce })
  headers.set(E2EE_HEADER, REMOTE_E2EE_VERSION)
  headers.set(E2EE_DEVICE_HEADER, pairing.deviceId)
  headers.set(E2EE_KEY_HEADER, pairing.keyId)
  headers.set(E2EE_INNER_CONTENT_TYPE_HEADER, innerContentType)
  headers.delete('content-length')
  if (hasBody) headers.set('content-type', 'application/json')
  else headers.set(E2EE_PROOF_HEADER, encodeEnvelope(envelope))
  // The Broker token is for Broker; the machine's direct listener never needs it.
  if (route.kind === 'direct') headers.delete('authorization')

  const encryptedRequest = new Request(route.kind === 'direct' ? `${route.base}${apiPath}` : request.url, {
    method,
    headers,
    body: hasBody ? encodeEnvelope(envelope) : undefined,
    credentials: route.kind === 'direct' ? 'omit' : request.credentials,
    // Ciphertext is bound to this request's nonce, so a cached response can
    // never decrypt. The node says no-store, but nodes before that fix leaked a
    // route's immutable Cache-Control, and webviews still hold those copies.
    cache: 'no-store',
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    integrity: request.integrity,
    keepalive: request.keepalive,
    signal: request.signal,
  })
  let response: Response
  try {
    response = await fetchImpl(encryptedRequest)
  } catch (error) {
    if (route.kind !== 'direct' || request.signal.aborted) throw error
    markDirectFailed(remote.nodeId, route.base)
    // A read is safe to send again; anything else may have arrived, and is not sent twice.
    if (retry && (method === 'GET' || method === 'HEAD')) return secureBrokerFetch(fetchImpl, retry)
    throw error
  }
  if (route.kind === 'direct') {
    const refusal = await turnedAway(response)
    if (refusal !== null) {
      // Turned away before reaching the machine's server: Broker may carry it.
      markDirectFailed(remote.nodeId, route.base, refusal)
      if (retry) {
        void response.body?.cancel().catch(() => undefined)
        return secureBrokerFetch(fetchImpl, retry)
      }
      return response
    }
  }
  noteRoute(remote.nodeId, route.kind)
  if (response.headers.get(E2EE_HEADER) !== REMOTE_E2EE_VERSION) {
    if (!response.ok) {
      const body = await response.clone().json().catch(() => null) as { error?: unknown } | null
      // `key_invalid`: the machine knows this device id under a different key — the
      // device re-paired elsewhere (another profile sharing this machine identity) or
      // reinstalled. The stored key can never work here again, so drop it and re-pair;
      // pairing upserts by device id, replacing the stale key on the machine too.
      if (response.status === 403 && (body?.error === 'e2ee_device_untrusted' || body?.error === 'e2ee_key_invalid')) {
        await removeRemotePairing(remote.nodeId)
        window.dispatchEvent(new CustomEvent(E2EE_PAIRING_REQUIRED_EVENT, { detail: { nodeId: remote.nodeId } }))
      }
      return response
    }
    throw new Error('The machine returned an unencrypted response')
  }
  const responseBinding = response.headers.get(E2EE_CONTEXT_HEADER)
  const resumeChatId = apiPath.match(/^\/api\/ai\/chat\/resume\/([^/?]+)/)?.[1]
  const expectedContext = resumeChatId
    ? loadChatContext(remote.nodeId, decodeURIComponent(resumeChatId))
    : context
  if (!responseBinding || responseBinding !== expectedContext) {
    throw new Error('Encrypted response does not belong to this request')
  }
  const chatId = response.headers.get('X-Chat-Id')
  if (chatId && !resumeChatId) saveChatContext(remote.nodeId, chatId, responseBinding)
  const onLost = route.kind === 'direct'
    ? (() => { const base = route.base; return () => markDirectFailed(remote.nodeId, base) })()
    : undefined
  return decryptResponse(response, keys.response, pairing.deviceId, pairing.keyId, responseBinding, onLost)
}

async function turnedAway(response: Response): Promise<string | null> {
  if ((response.status !== 503 && response.status !== 403) || response.headers.get(E2EE_HEADER)) return null
  const body = await response.clone().json().catch(() => null) as { error?: unknown; message?: unknown } | null
  if (typeof body?.error !== 'string' || !DIRECT_TURNED_AWAY.has(body.error)) return null
  return typeof body.message === 'string' ? body.message : body.error
}

/**
 * No device key for this machine yet — so ask the machine instead of deciding
 * for it.
 *
 * Throwing here (which this used to do) made the client the authority on a
 * policy only the node holds: a node running with E2EE off answers a plain
 * request normally, and the request never reached it to find that out. A node
 * that does require encryption answers 426 from `createRemoteE2EEMiddleware`,
 * and that is the signal to send the user to the pairing card — the same place
 * the old throw was trying to get them to, now reached on the node's word.
 */
async function unpairedFetch(
  fetchImpl: typeof window.fetch,
  request: Request,
  nodeId: string,
): Promise<Response> {
  const response = await fetchImpl(request)
  if (response.status === 426) {
    window.dispatchEvent(new CustomEvent(E2EE_PAIRING_REQUIRED_EVENT, { detail: { nodeId } }))
  }
  return response
}

function parseRemoteApiUrl(url: string): { nodeId: string } | null {
  const parsed = new URL(url)
  const match = parsed.pathname.match(/^\/u\/[^/]+\/n\/([^/]+)\/api(?:\/|$)/)
  return match?.[1] ? { nodeId: decodeURIComponent(match[1]) } : null
}

/** `onLost`: the body broke off midway (not cancelled by the reader), which says the direct route is gone. */
function decryptResponse(
  response: Response, key: Uint8Array, deviceId: string, keyId: string, context: string, onLost?: () => void,
): Response {
  const headers = new Headers(response.headers)
  const framing = headers.get(E2EE_FRAMING_HEADER)
  if (framing !== 'sse' && framing !== 'ndjson') throw new Error('Invalid encrypted response framing')
  const innerContentType = headers.get(E2EE_INNER_CONTENT_TYPE_HEADER)
  for (const name of [E2EE_HEADER, E2EE_CONTEXT_HEADER, E2EE_FRAMING_HEADER, E2EE_INNER_CONTENT_TYPE_HEADER]) headers.delete(name)
  if (innerContentType) headers.set('content-type', innerContentType)
  else headers.delete('content-type')
  headers.delete('content-length')
  if (!response.body) return new Response(null, { status: response.status, statusText: response.statusText, headers })

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let expectedSeq = 0
  let sawFinal = false
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!sawFinal) {
          const record = takeRecord()
          if (record !== null) {
            const frame = decodeStreamFrame(record)
            if (frame.seq !== expectedSeq) throw new Error('Encrypted response frame is out of order')
            const plaintext = open(frame, key, responseFrameAad({
              deviceId,
              keyId,
              context,
              status: response.status,
              framing,
              innerContentType: innerContentType ?? '',
              seq: frame.seq,
              final: frame.final,
            }))
            expectedSeq += 1
            sawFinal = frame.final
            if (plaintext.length > 0) {
              controller.enqueue(plaintext)
              return
            }
            if (sawFinal) controller.close()
            continue
          }
          const { value, done } = await reader.read()
          buffer += decoder.decode(value, { stream: !done })
          if (done) {
            if (!sawFinal) throw new Error('Encrypted response ended before its final frame')
            controller.close()
            return
          }
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) onLost?.()
        controller.error(error)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })

  function takeRecord(): string | null {
    if (framing === 'ndjson') {
      const end = buffer.indexOf('\n')
      if (end < 0) return null
      const record = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      return record || takeRecord()
    }
    const end = buffer.indexOf('\n\n')
    if (end < 0) return null
    const block = buffer.slice(0, end)
    buffer = buffer.slice(end + 2)
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    return data || takeRecord()
  }

  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

export const secureFetchTestUtils = { parseRemoteApiUrl, encoder }

function chatContextKey(nodeId: string, chatId: string): string {
  return `operon.e2ee.chat-context.${nodeId}.${chatId}`
}

function saveChatContext(nodeId: string, chatId: string, context: string): void {
  try { localStorage.setItem(chatContextKey(nodeId, chatId), context) } catch {}
}

function loadChatContext(nodeId: string, chatId: string): string | null {
  try { return localStorage.getItem(chatContextKey(nodeId, chatId)) } catch { return null }
}
