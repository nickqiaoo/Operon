import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { DELEGATION_NODE_ID, DIRECT_PING_PATH, MACHINE_PAIR_CLAIM_PATH, type DirectPing } from '@shared/delegations'
import {
  DELEGATION_PUBLIC_KEY_HEADER, DELEGATION_SOURCE_HEADER, DELEGATION_SOURCE_LABEL_HEADER, DELEGATION_TUNNEL_HEADER,
  E2EE_DEVICE_HEADER, PAIRING_HEADER, REMOTE_TUNNEL_HEADER,
} from '@shared/e2ee/protocol'
import { API_TOKEN_HEADER } from './api-token.js'

/**
 * The door other machines use to reach this one over Tailscale, without Broker.
 *
 * It does for a direct request what the tunnel agent does for one Broker
 * relays (tunnel-agent/src/forward.ts), then hands it to this machine's server
 * on loopback: it marks the request remote, supplies the local API token, and
 * stamps which machine sent it. Every one of those headers a caller sent is
 * dropped first, so nothing that comes through here can pass for this
 * machine's own window.
 *
 * Only another machine this one trusts, or a phone (or browser) paired with
 * it, gets through, and only end to end encrypted: the server's E2EE
 * middleware opens the request with the key pinned when the two paired, so
 * the stamp only says which key to try. A phone gets no source stamp, exactly
 * as through Broker.
 *
 * Pairing is the one exception, for machines and phones that do not use
 * Broker: a claim comes from someone not paired yet and skips E2EE, but it is
 * sealed under the pairing code, which the route checks, exactly as when Broker
 * carries it. Only the claim (and, for phones, its status) gets through
 * unpaired; every other pairing route is local only.
 *
 * Phones arrive through Tailscale Serve (HTTPS on the MagicDNS name), which
 * proxies to this listener's loopback side; machines arrive on the tailnet
 * address in plain HTTP. Both get the same treatment.
 */

export interface DirectIngressOptions {
  /** The port of this machine's server on 127.0.0.1. */
  localPort: () => number | null
  /** The local API token; undefined when token auth is off. */
  localToken: () => string | undefined
  /** Proves to the server that the source stamp was set here (delegation-tunnel.ts). */
  delegationTunnelToken: string
  selfNodeId: () => string | null
  /** What this machine calls itself, in the ping (finding machines on the tailnet). */
  selfLabel?: () => string | null
  /** A machine this one trusts, or null. */
  trustedPeer: (nodeId: string) => { label: string | null } | null
  /** A phone or browser paired with this machine (a confirmed device). */
  pairedDevice?: (deviceId: string) => boolean
  /** Direct requests are served only while remote requests must be encrypted. */
  e2eeRequired: () => boolean
  /** For tests; Broker's cadence otherwise. */
  sseKeepaliveMs?: number
}

/** Every header a caller may not set itself; lowercase, as Node delivers them. */
const STRIPPED = new Set([
  REMOTE_TUNNEL_HEADER, API_TOKEN_HEADER, DELEGATION_TUNNEL_HEADER, DELEGATION_SOURCE_HEADER,
  DELEGATION_PUBLIC_KEY_HEADER, DELEGATION_SOURCE_LABEL_HEADER,
  // Broker's webhook deliveries (gateway/surfaces/route.ts) are refused here anyway.
  'x-operon-origin', 'x-operon-route-reason', 'x-operon-actor',
  'authorization', 'cookie', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  // Hop-by-hop: the hop to the server is a new connection.
  'proxy-authorization', 'proxy-connection', 'keep-alive', 'te', 'trailer',
  // Pairing skips E2EE; it is refused here anyway, and never passed on.
  PAIRING_HEADER,
].map((name) => name.toLowerCase()))

/** What the web client reads off a response (same list as Broker's, broker/main.go). */
const EXPOSED_HEADERS = 'X-Chat-Id, X-Turn-Id, X-Message-Id, X-Operon-Error-Code, X-Operon-E2EE, X-Operon-E2EE-Context, X-Operon-E2EE-Framing, X-Operon-Inner-Content-Type'

/** Same cadence as Broker's (broker/http_proxy.go), which the other machine's idle limit expects. */
const SSE_KEEPALIVE_MS = 15_000
const SSE_KEEPALIVE = Buffer.from(': keepalive\n\n')

type Refusal = { status: number; error: string; message: string }
/** A machine (`source` stamped) or a paired phone (no stamp, as through Broker). */
type Admitted = { source: string; label: string | null; pairing?: false } | { source: null; label: null; pairing?: boolean }

/** A phone's pairing claim and status poll, sealed under the code in its QR (routes/remote-e2ee.ts). */
const PHONE_PAIRING = /^\/api\/e2ee\/pair\/(claim|status\/[^/]+)$/

/** Who a request is from, or why it is refused. */
function admit(options: DirectIngressOptions, method: string, url: URL, deviceId: string | undefined, pairing: boolean): Admitted | Refusal {
  if (!options.e2eeRequired()) {
    return { status: 503, error: 'direct_unavailable', message: 'Direct connections need end-to-end encryption, which is off on this machine' }
  }
  if (!url.pathname.startsWith('/api/')) return { status: 404, error: 'not_found', message: 'Not found' }
  // Broker's own deliveries skip E2EE; they never come through here.
  const lower = url.pathname.toLowerCase()
  if (lower.startsWith('/api/integrations/')) {
    return { status: 403, error: 'forbidden', message: 'Not available directly' }
  }
  if (pairing && PHONE_PAIRING.test(url.pathname)) return { source: null, label: null, pairing: true }
  // Every other pairing route is this machine's own window's.
  if (pairing || lower.startsWith('/api/e2ee/pair')) {
    return { status: 403, error: 'forbidden', message: 'Not available directly' }
  }
  if (!deviceId || deviceId === options.selfNodeId()) {
    return { status: 403, error: 'direct_device_unknown', message: 'Only paired machines and devices can connect directly' }
  }
  if (DELEGATION_NODE_ID.test(deviceId)) {
    const peer = options.trustedPeer(deviceId)
    if (peer) return { source: deviceId, label: peer.label }
    // A machine pairing with this one: it says who it is, and the sealed claim must agree.
    if (method === 'POST' && url.pathname === MACHINE_PAIR_CLAIM_PATH) return { source: deviceId, label: null }
    return { status: 403, error: 'machine_not_paired', message: 'This machine is not paired with the one that sent the request. Pair them in Settings → Remote.' }
  }
  if (options.pairedDevice?.(deviceId)) return { source: null, label: null }
  // Not `e2ee_device_untrusted`: a client drops its pairing on that one, and
  // this door is not where that is decided. It goes through Broker instead.
  return { status: 403, error: 'direct_device_unknown', message: 'This device is not paired with this machine' }
}

function forwardedHeaders(options: DirectIngressOptions, headers: IncomingHttpHeaders, port: number, from: Admitted): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    // `tailscale-*`: what Tailscale Serve says about the caller, which nothing here reads.
    if (value === undefined || STRIPPED.has(name) || name.startsWith('x-operon-webhook') || name.startsWith('tailscale-')) continue
    out[name] = value
  }
  out.host = `127.0.0.1:${port}`
  out[REMOTE_TUNNEL_HEADER.toLowerCase()] = '1'
  const token = options.localToken()
  if (token) out[API_TOKEN_HEADER] = token
  if (from.pairing) out[PAIRING_HEADER.toLowerCase()] = 'v1'
  if (from.source === null) return out
  out[DELEGATION_SOURCE_HEADER.toLowerCase()] = from.source
  out[DELEGATION_TUNNEL_HEADER.toLowerCase()] = options.delegationTunnelToken
  if (from.label) out[DELEGATION_SOURCE_LABEL_HEADER.toLowerCase()] = Buffer.from(from.label, 'utf8').toString('base64')
  return out
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * The phone app (`capacitor://localhost`, `https://localhost`) and the web
 * client call from another origin. Any origin may read an answer: every one
 * that matters is sealed for a paired device, and nothing here rides on
 * cookies, so there are no credentials to share.
 */
function setCors(req: IncomingMessage, res: ServerResponse): void {
  if (!req.headers.origin) return
  res.setHeader('access-control-allow-origin', req.headers.origin)
  res.setHeader('vary', 'Origin, Access-Control-Request-Headers')
  res.setHeader('access-control-expose-headers', EXPOSED_HEADERS)
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function handleRequest(options: DirectIngressOptions, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://direct.invalid')
  setCors(req, res)
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    const requested = header(req.headers, 'access-control-request-headers')
    if (requested) res.setHeader('access-control-allow-headers', requested)
    res.setHeader('access-control-max-age', '600')
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method === 'GET' && url.pathname === DIRECT_PING_PATH) {
    const nodeId = options.selfNodeId()
    if (!nodeId) return sendJson(res, 503, { error: 'not_connected' })
    const label = options.selfLabel?.()
    const ping: DirectPing = { v: 1, nodeId, ...(label ? { label } : {}) }
    return sendJson(res, 200, ping)
  }
  const port = options.localPort()
  if (!port) return sendJson(res, 503, { error: 'starting', message: 'This machine is starting' })
  const pairingHeader = header(req.headers, PAIRING_HEADER)
  // Only the current pairing version is passed on; any other is refused as pairing.
  const admitted = admit(options, req.method ?? 'GET', url, header(req.headers, E2EE_DEVICE_HEADER), pairingHeader !== undefined)
  if (!('error' in admitted) && admitted.pairing && pairingHeader !== 'v1') {
    return sendJson(res, 400, { error: 'pairing_version', message: 'Update Operon on this device' })
  }
  if ('error' in admitted) return sendJson(res, admitted.status, { error: admitted.error, message: admitted.message })

  const upstream = http.request({
    host: '127.0.0.1',
    port,
    method: req.method,
    path: req.url,
    headers: forwardedHeaders(options, req.headers, port, admitted),
  })
  let keepalive: ReturnType<typeof setInterval> | undefined
  const finish = () => {
    if (keepalive) clearInterval(keepalive)
    keepalive = undefined
  }
  upstream.on('response', (answer) => {
    const headers = { ...answer.headers }
    delete headers.connection
    delete headers['keep-alive']
    // The server's own CORS answer is for its local surfaces; this door has its own.
    for (const name of Object.keys(headers)) if (name.startsWith('access-control-')) delete headers[name]
    res.writeHead(answer.statusCode ?? 502, headers)
    res.flushHeaders()
    // Broker keeps a quiet event stream alive with comment lines; the other
    // machine's reader expects them. Only between events, never inside one.
    const isEventStream = /text\/event-stream/i.test(String(answer.headers['content-type'] ?? ''))
    let atBoundary = true
    let tail = ''
    if (isEventStream) {
      keepalive = setInterval(() => {
        if (atBoundary && !res.writableEnded) res.write(SSE_KEEPALIVE)
      }, options.sseKeepaliveMs ?? SSE_KEEPALIVE_MS)
      keepalive.unref?.()
    }
    answer.on('data', (chunk: Buffer) => {
      if (isEventStream && chunk.length) {
        tail = (tail + chunk.subarray(Math.max(0, chunk.length - 2)).toString('latin1')).slice(-2)
        atBoundary = tail === '\n\n'
      }
      if (!res.write(chunk)) {
        answer.pause()
        res.once('drain', () => answer.resume())
      }
    })
    answer.on('end', () => {
      finish()
      res.end()
    })
    answer.on('error', () => {
      finish()
      res.destroy()
    })
  })
  upstream.on('error', () => {
    finish()
    if (!res.headersSent) sendJson(res, 502, { error: 'upstream_failed', message: 'This machine could not answer' })
    else res.destroy()
  })
  // The caller went away: stop the work it asked for, as Broker does.
  res.on('close', () => {
    finish()
    if (!upstream.destroyed) upstream.destroy()
  })
  req.pipe(upstream)
}

function refuseUpgrade(socket: Duplex, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  const reason = http.STATUS_CODES[status] ?? 'Error'
  socket.end(`HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`)
}

function handleUpgrade(options: DirectIngressOptions, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', 'http://direct.invalid')
  const port = options.localPort()
  if (!port) return refuseUpgrade(socket, 503, { error: 'starting' })
  // A browser cannot set headers on a WebSocket, so the terminal names its
  // device in the query (routes/terminal.ts checks it against the keys).
  const admitted = admit(options, req.method ?? 'GET', url, url.searchParams.get('deviceId') ?? undefined, header(req.headers, PAIRING_HEADER) !== undefined)
  if (!('error' in admitted) && (admitted.pairing || (admitted.source && !options.trustedPeer(admitted.source)))) {
    return refuseUpgrade(socket, 403, { error: 'forbidden' })
  }
  if ('error' in admitted) return refuseUpgrade(socket, admitted.status, { error: admitted.error, message: admitted.message })

  const headers = forwardedHeaders(options, req.headers, port, admitted)
  const lines = [`${req.method ?? 'GET'} ${req.url} HTTP/1.1`]
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (/[\r\n]/.test(item)) return refuseUpgrade(socket, 400, { error: 'bad_request' })
      lines.push(`${name}: ${item}`)
    }
  }
  const upstream = net.connect(port, '127.0.0.1', () => {
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  const close = () => {
    upstream.destroy()
    socket.destroy()
  }
  upstream.on('error', close)
  socket.on('error', close)
  upstream.on('close', () => socket.destroy())
  socket.on('close', () => upstream.destroy())
}

export function createDirectIngress(options: DirectIngressOptions): http.Server {
  const server = http.createServer((req, res) => handleRequest(options, req, res))
  server.on('upgrade', (req, socket, head) => handleUpgrade(options, req, socket, head))
  // Event streams and long requests stay open as long as they are alive.
  server.requestTimeout = 0
  server.headersTimeout = 30_000
  server.on('clientError', (_error, socket) => {
    if (!socket.destroyed && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })
  return server
}
