import { getApiTokenSync, getBaseUrl } from './api-client.js'
import { ensureAccessToken, getBrokerWsProtocols, getSelectedNodeId, notifyNodeOffline } from './web-auth.js'
import { decodeWebSocketFrame, utf8, webSocketFrameAad } from '@shared/e2ee/protocol'
import { deriveRemoteDirectionKeys, open, seal } from './e2ee/crypto'
import { getRemotePairing } from './e2ee/device-store'

type CreateOptions = { cwd?: string; cols?: number; rows?: number; launch?: string }

type ClientMessage =
  | { type: 'create'; requestId: number; options?: CreateOptions }
  | { type: 'write'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'close'; id: string }

type ServerMessage =
  | { type: 'created'; id: string; requestId?: number; launchCommand?: string }
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number; signal?: number }
  | { type: 'error'; message: string; requestId?: number }

type DataCallback = (id: string, data: string) => void
type ExitCallback = (id: string, exit: { exitCode: number; signal?: number }) => void

type CreateResult = { id: string; launchCommand?: string }

type PendingCreate = {
  resolve: (result: CreateResult) => void
  reject: (error: Error) => void
  timeoutId: number
}

const CREATE_TIMEOUT_MS = 10000

let ws: WebSocket | null = null
let connectingPromise: Promise<WebSocket> | null = null

interface SecureSocketState {
  deviceId: string
  keyId: string
  requestKey: Uint8Array
  responseKey: Uint8Array
  sendSeq: number
  receiveSeq: number
}

let secureSocket: SecureSocketState | null = null

const dataListeners = new Set<DataCallback>()
const exitListeners = new Set<ExitCallback>()
const pendingCreates = new Map<number, PendingCreate>()
let createCounter = 0

function settleCreateSuccess(requestId: number, id: string, launchCommand?: string): boolean {
  const pending = pendingCreates.get(requestId)
  if (!pending) return false
  clearTimeout(pending.timeoutId)
  pendingCreates.delete(requestId)
  pending.resolve({ id, launchCommand })
  return true
}

function settleCreateError(requestId: number, message: string): boolean {
  const pending = pendingCreates.get(requestId)
  if (!pending) return false
  clearTimeout(pending.timeoutId)
  pendingCreates.delete(requestId)
  pending.reject(new Error(message))
  return true
}

function settleFirstPendingCreateSuccess(id: string, launchCommand?: string): boolean {
  const iterator = pendingCreates.entries().next()
  if (iterator.done) return false
  const [requestId] = iterator.value
  return settleCreateSuccess(requestId, id, launchCommand)
}

function settleFirstPendingCreateError(message: string): boolean {
  const iterator = pendingCreates.entries().next()
  if (iterator.done) return false
  const [requestId] = iterator.value
  return settleCreateError(requestId, message)
}

function rejectAllPendingCreates(message: string) {
  for (const [requestId, pending] of pendingCreates) {
    clearTimeout(pending.timeoutId)
    pending.reject(new Error(message))
    pendingCreates.delete(requestId)
  }
}

async function handleMessage(event: MessageEvent) {
  try {
    let text = typeof event.data === 'string' ? event.data : await new Response(event.data).text()
    if (secureSocket) {
      const frame = decodeWebSocketFrame(text)
      if (frame.seq !== secureSocket.receiveSeq) throw new Error('Encrypted terminal frame is out of order')
      text = new TextDecoder().decode(open(
        frame,
        secureSocket.responseKey,
        webSocketFrameAad({
          direction: 'server-to-client',
          deviceId: secureSocket.deviceId,
          keyId: secureSocket.keyId,
          seq: frame.seq,
        }),
      ))
      secureSocket.receiveSeq += 1
    }
    const msg = JSON.parse(text) as ServerMessage
    switch (msg.type) {
      case 'created':
        if (typeof msg.requestId === 'number') {
          if (!settleCreateSuccess(msg.requestId, msg.id, msg.launchCommand)) {
            settleFirstPendingCreateSuccess(msg.id, msg.launchCommand)
          }
        } else {
          settleFirstPendingCreateSuccess(msg.id, msg.launchCommand)
        }
        break
      case 'data':
        for (const cb of dataListeners) cb(msg.id, msg.data)
        break
      case 'exit':
        for (const cb of exitListeners) cb(msg.id, { exitCode: msg.exitCode, signal: msg.signal })
        break
      case 'error':
        if (typeof msg.requestId === 'number') {
          if (!settleCreateError(msg.requestId, msg.message)) {
            settleFirstPendingCreateError(msg.message)
          }
        } else {
          settleFirstPendingCreateError(msg.message)
        }
        console.error('Terminal WS error:', msg.message)
        break
    }
  } catch (e) {
    console.warn('[terminal-ws] Failed to parse server message:', e)
  }
}

async function ensureConnection(): Promise<WebSocket> {
  // Already open
  if (ws && ws.readyState === WebSocket.OPEN) return ws

  // Connection in progress — wait for it
  if (connectingPromise) return connectingPromise

  connectingPromise = (async () => {
    const baseUrl = await getBaseUrl()
    const wsUrl = new URL(baseUrl.replace(/^http/, 'ws') + '/terminal/ws')

    // Web target tunnels through the broker, which authenticates the WS handshake via
    // a bearer subprotocol (no Authorization header on browser WebSockets). Electron
    // talks straight to 127.0.0.1 and presents the local api token via the query —
    // browser WebSockets cannot set headers either.
    if (__APP_TARGET__ !== 'web') {
      const token = getApiTokenSync()
      if (token) wsUrl.searchParams.set('token', token)
    }
    if (__APP_TARGET__ === 'web' && !(await ensureAccessToken())) {
      throw new Error('Not authenticated')
    }
    if (__APP_TARGET__ === 'web') {
      const nodeId = getSelectedNodeId()
      const pairing = nodeId ? await getRemotePairing(nodeId) : null
      // No key for this machine: offer a plain handshake and let the machine
      // rule on it, the same way secure-fetch does. One running with E2EE off
      // accepts it; one that requires E2EE answers 426 (routes/terminal.ts).
      // Refusing here instead would decide that in the machine's place.
      if (pairing) {
        const keys = deriveRemoteDirectionKeys(pairing)
        secureSocket = {
          deviceId: pairing.deviceId,
          keyId: pairing.keyId,
          requestKey: keys.request,
          responseKey: keys.response,
          sendSeq: 0,
          receiveSeq: 0,
        }
        wsUrl.searchParams.set('e2ee', 'v1')
        wsUrl.searchParams.set('deviceId', pairing.deviceId)
        wsUrl.searchParams.set('keyId', pairing.keyId)
      } else {
        secureSocket = null
      }
    } else {
      secureSocket = null
    }
    const protocols = __APP_TARGET__ === 'web' ? getBrokerWsProtocols() : undefined
    const socket = new WebSocket(wsUrl, protocols)

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.onopen = null
        socket.onerror = null
      }
      socket.onopen = () => {
        cleanup()
        resolve()
      }
      socket.onerror = () => {
        cleanup()
        if (__APP_TARGET__ === 'web') notifyNodeOffline()
        reject(new Error('Failed to connect terminal websocket'))
      }
    })

    socket.onmessage = (event) => { void handleMessage(event) }
    socket.onclose = () => {
      if (ws === socket) {
        ws = null
        secureSocket = null
      }
      rejectAllPendingCreates('Terminal connection closed')
    }
    socket.onerror = () => {
      if (ws === socket) {
        ws = null
        secureSocket = null
      }
      rejectAllPendingCreates('Terminal connection error')
    }

    ws = socket
    connectingPromise = null
    return socket
  })()

  connectingPromise.catch((e) => {
    console.warn('[terminal-ws] Connection failed:', e)
    connectingPromise = null
  })

  return connectingPromise
}

export async function createTerminal(
  options?: CreateOptions
): Promise<CreateResult> {
  const socket = await ensureConnection()

  return new Promise<CreateResult>((resolve, reject) => {
    const key = createCounter++
    const timeoutId = window.setTimeout(() => {
      settleCreateError(key, 'Timed out while creating terminal')
    }, CREATE_TIMEOUT_MS)

    pendingCreates.set(key, { resolve, reject, timeoutId })

    const payload: ClientMessage = { type: 'create', requestId: key, options }

    try {
      sendSecure(socket, payload)
    } catch {
      settleCreateError(key, 'Failed to send create request')
    }
  })
}

export async function writeTerminal(id: string, data: string): Promise<boolean> {
  const socket = await ensureConnection()
  const payload: ClientMessage = { type: 'write', id, data }
  sendSecure(socket, payload)
  return true
}

export async function resizeTerminal(id: string, cols: number, rows: number): Promise<boolean> {
  const socket = await ensureConnection()
  const payload: ClientMessage = { type: 'resize', id, cols, rows }
  sendSecure(socket, payload)
  return true
}

export async function closeTerminal(id: string): Promise<boolean> {
  const socket = await ensureConnection()
  const payload: ClientMessage = { type: 'close', id }
  sendSecure(socket, payload)
  return true
}

export function onTerminalData(callback: DataCallback): () => void {
  dataListeners.add(callback)
  ensureConnection().catch((e) => console.warn('[terminal-ws] Connection failed:', e))
  return () => dataListeners.delete(callback)
}

export function onTerminalExit(callback: ExitCallback): () => void {
  exitListeners.add(callback)
  ensureConnection().catch((e) => console.warn('[terminal-ws] Connection failed:', e))
  return () => exitListeners.delete(callback)
}

function sendSecure(socket: WebSocket, payload: ClientMessage): void {
  const plaintext = JSON.stringify(payload)
  if (!secureSocket) {
    socket.send(plaintext)
    return
  }
  const seq = secureSocket.sendSeq
  const frame = {
    ...seal(
      utf8(plaintext),
      secureSocket.requestKey,
      webSocketFrameAad({
        direction: 'client-to-server',
        deviceId: secureSocket.deviceId,
        keyId: secureSocket.keyId,
        seq,
      }),
    ),
    seq,
  }
  secureSocket.sendSeq += 1
  socket.send(JSON.stringify(frame))
}
