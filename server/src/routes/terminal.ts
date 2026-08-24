import { Hono } from 'hono'
import type { NodeWebSocket } from '@hono/node-ws'
import type WebSocket from 'ws'
import type { WSContext, WSMessageReceive } from 'hono/ws'
import {
  REMOTE_E2EE_VERSION,
  REMOTE_TUNNEL_HEADER,
  decodeWebSocketFrame,
  utf8,
  webSocketFrameAad,
} from '@shared/e2ee/protocol'
import * as terminalService from '../services/terminal.js'
import {
  getConfirmedRemoteDeviceKeys,
  getRemoteE2EEMode,
  openRemoteEnvelope,
  sealRemoteEnvelope,
} from '../services/remote-e2ee.js'
import {
  getClaudeCliPath,
  getCodexBinaryPath,
  getKimiCliPath,
  getGrokCliPath,
  getOpencodeBinaryPath,
} from '../services/adapter/bundled-cli-paths.js'

function resolveLaunchCommand(launch: string | undefined): string | undefined {
  switch (launch) {
    case 'claude': return getClaudeCliPath() ?? 'claude'
    case 'codex': return getCodexBinaryPath() ?? 'codex'
    case 'opencode': return getOpencodeBinaryPath() ?? 'opencode'
    case 'kimi': return getKimiCliPath() ?? 'kimi'
    case 'grok': return getGrokCliPath() ?? 'grok'
    case 'cursor-agent':
    case 'copilot':
    case 'gemini': return launch
    default: return undefined
  }
}

type WSMessage =
  | { type: 'create'; requestId?: number; options?: { cwd?: string; cols?: number; rows?: number; launch?: string } }
  | { type: 'write'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'close'; id: string }

type WSResponse =
  | { type: 'created'; id: string; requestId?: number; launchCommand?: string }
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number; signal?: number }
  | { type: 'error'; message: string; requestId?: number }

interface SecureWebSocketState {
  deviceId: string
  keyId: string
  requestKey: Uint8Array
  responseKey: Uint8Array
  receiveSeq: number
  sendSeq: number
}

export function terminalRoutes(upgradeWebSocket: NodeWebSocket['upgradeWebSocket']) {
  const router = new Hono()

  router.get('/ws', async (c, next) => {
    const remote = c.req.header(REMOTE_TUNNEL_HEADER) === '1'
    const e2ee = c.req.query('e2ee')
    let secure: SecureWebSocketState | null = null
    if (remote && e2ee !== REMOTE_E2EE_VERSION && getRemoteE2EEMode() === 'required') {
      return c.json({ error: 'e2ee_required', message: 'Secure pairing is required' }, 426)
    }
    if (remote && e2ee === REMOTE_E2EE_VERSION) {
      const deviceId = c.req.query('deviceId')
      const keyId = c.req.query('keyId')
      const keys = deviceId && keyId ? getConfirmedRemoteDeviceKeys(deviceId, keyId) : null
      if (!deviceId || !keyId || !keys) return c.json({ error: 'e2ee_device_untrusted' }, 403)
      secure = {
        deviceId,
        keyId,
        requestKey: keys.request,
        responseKey: keys.response,
        receiveSeq: 0,
        sendSeq: 0,
      }
    }

    const handler = upgradeWebSocket(() => ({
      async onMessage(event, ws) {
        try {
          let text = await messageText(event.data)
          if (secure) {
            const frame = decodeWebSocketFrame(text)
            if (frame.seq !== secure.receiveSeq) throw new Error('Encrypted terminal frame is out of order')
            text = new TextDecoder().decode(openRemoteEnvelope(
              frame,
              secure.requestKey,
              webSocketFrameAad({
                direction: 'client-to-server',
                deviceId: secure.deviceId,
                keyId: secure.keyId,
                seq: frame.seq,
              }),
            ))
            secure.receiveSeq += 1
          }
          handleMessage(JSON.parse(text) as WSMessage, createSender(ws, secure))
        } catch (error) {
          createSender(ws, secure)({
            type: 'error',
            message: error instanceof Error ? error.message : 'Invalid message',
          })
        }
      },
      onClose() {
        // PTY ownership remains with the explicit close message, matching the
        // existing reconnect behavior.
      },
    }))
    return handler(c, next)
  })

  return router
}

function createSender(ws: WSContext<WebSocket>, secure: SecureWebSocketState | null) {
  return (data: WSResponse): void => {
    try {
      const plaintext = JSON.stringify(data)
      if (!secure) {
        ws.send(plaintext)
        return
      }
      const seq = secure.sendSeq
      const frame = {
        ...sealRemoteEnvelope(
          utf8(plaintext),
          secure.responseKey,
          webSocketFrameAad({
            direction: 'server-to-client',
            deviceId: secure.deviceId,
            keyId: secure.keyId,
            seq,
          }),
        ),
        seq,
      }
      secure.sendSeq += 1
      ws.send(JSON.stringify(frame))
    } catch {
      // The socket may have closed between a PTY callback and this send.
    }
  }
}

function handleMessage(msg: WSMessage, send: (response: WSResponse) => void): void {
  switch (msg.type) {
    case 'create': {
      const requestId = typeof msg.requestId === 'number' ? msg.requestId : undefined
      try {
        const id = terminalService.createTerminal(
          msg.options,
          (terminalId, data) => send({ type: 'data', id: terminalId, data }),
          (terminalId, exit) => send({ type: 'exit', id: terminalId, exitCode: exit.exitCode, signal: exit.signal }),
        )
        send({ type: 'created', id, requestId, launchCommand: resolveLaunchCommand(msg.options?.launch) })
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : 'Failed to create terminal', requestId })
      }
      break
    }
    case 'write': terminalService.writeTerminal(msg.id, msg.data); break
    case 'resize': terminalService.resizeTerminal(msg.id, msg.cols, msg.rows); break
    case 'close': terminalService.closeTerminal(msg.id); break
  }
}

async function messageText(data: WSMessageReceive): Promise<string> {
  if (typeof data === 'string') return data
  if (data instanceof Blob) return data.text()
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  }
  return new TextDecoder().decode(new Uint8Array(data))
}
