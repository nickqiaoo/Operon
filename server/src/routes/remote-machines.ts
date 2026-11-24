import { Hono } from 'hono'
import type { NodeWebSocket } from '@hono/node-ws'
import type { WSContext } from 'hono/ws'
import WebSocket, { type RawData } from 'ws'
import { DELEGATION_NODE_ID } from '@shared/delegations'
import { open, seal } from '@shared/e2ee/crypto'
import { REMOTE_TUNNEL_HEADER, decodeWebSocketFrame, utf8, webSocketFrameAad } from '@shared/e2ee/protocol'
import { DelegationHttpError, delegationSocket, relayRequest } from '../services/delegation-transport.js'

/**
 * `/api/remote/:nodeId/*` — this machine's UI using another machine of the
 * account as if it were its own server. A workspace on another machine is
 * opened through here: its chats, files, git, events and attachments.
 *
 * The renderer only ever talks to this server, with this server's token; this
 * server then speaks to the other machine end to end encrypted through Broker,
 * as itself (its delegation key). The other machine decides what it lets
 * through (`nodeDelegationRoute`, the "Run agents for other machines" switch).
 */
export function remoteMachineRoutes(upgradeWebSocket: NodeWebSocket['upgradeWebSocket']) {
  const app = new Hono()
  app.get('/:nodeId/terminal/ws', async (c, next) => {
    if (c.req.header(REMOTE_TUNNEL_HEADER) === '1') return c.json({ error: 'remote_relay_denied' }, 403)
    const target = c.req.param('nodeId')
    if (!DELEGATION_NODE_ID.test(target)) return c.json({ error: 'Invalid machine' }, 400)
    return upgradeWebSocket(() => relayTerminal(target))(c, next)
  })
  app.all('/:nodeId/*', async (c) => {
    // Only this machine's own UI: a paired phone or another machine reaching this
    // server must not be able to hop on to a third one through it.
    if (c.req.header(REMOTE_TUNNEL_HEADER) === '1') {
      return c.json({ error: 'remote_relay_denied', message: 'Open this machine directly to reach the others' }, 403)
    }
    const target = c.req.param('nodeId')
    if (!DELEGATION_NODE_ID.test(target)) return c.json({ error: 'Invalid machine' }, 400)
    const url = new URL(c.req.url)
    const prefix = `/api/remote/${target}`
    const rest = url.pathname.slice(prefix.length)
    if (!url.pathname.startsWith(`${prefix}/`) || rest.length < 2) return c.json({ error: 'Not found' }, 404)
    // `?token=` is this server's own credential (for `<img src>` and the like);
    // the other machine's tunnel agent supplies that machine's token.
    if (url.searchParams.has('token')) url.searchParams.delete('token')
    const apiPath = `/api${rest}${url.search}`
    try {
      return await relayRequest(target, apiPath, c.req.raw)
    } catch (error) {
      if (error instanceof DelegationHttpError) {
        return new Response(JSON.stringify({ error: error.code ?? error.message, message: error.message }), {
          // A 401 here would read as "this server's token is wrong" to the renderer.
          status: error.status === 401 ? 403 : error.status, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 })
      throw error
    }
  })
  return app
}

/**
 * The renderer's terminal socket for another machine. The renderer speaks plain
 * JSON frames to this server; each is sealed with the delegation keys and sent
 * on to the other machine's `/api/terminal/ws` through Broker, and its answers
 * are opened on the way back.
 */
function relayTerminal(target: string) {
  let upstream: WebSocket | null = null
  let closed = false
  const pending: string[] = []
  let send: ((text: string) => void) | null = null

  const fail = (ws: WSContext, message: string) => {
    try { ws.send(JSON.stringify({ type: 'error', message })) } catch { /* closed */ }
    try { ws.close(1011, message.slice(0, 120)) } catch { /* closed */ }
  }

  return {
    onOpen(_event: Event, ws: WSContext) {
      void (async () => {
        try {
          const socket = await delegationSocket(target, '/api/terminal/ws')
          if (closed) return
          let sendSeq = 0
          let receiveSeq = 0
          const remote = new WebSocket(socket.url, [socket.protocol])
          upstream = remote
          send = (text) => {
            const seq = sendSeq++
            const frame = {
              ...seal(utf8(text), socket.keys.request, webSocketFrameAad({
                direction: 'client-to-server', deviceId: socket.deviceId, keyId: socket.keyId, seq,
              })),
              seq,
            }
            remote.send(JSON.stringify(frame))
          }
          remote.on('open', () => {
            for (const text of pending.splice(0)) send?.(text)
          })
          remote.on('message', (data: RawData) => {
            try {
              const frame = decodeWebSocketFrame(rawText(data))
              if (frame.seq !== receiveSeq) throw new Error('Encrypted terminal frame is out of order')
              const plaintext = open(frame, socket.keys.response, webSocketFrameAad({
                direction: 'server-to-client', deviceId: socket.deviceId, keyId: socket.keyId, seq: frame.seq,
              }))
              receiveSeq += 1
              ws.send(new TextDecoder().decode(plaintext))
            } catch (error) {
              fail(ws, error instanceof Error ? error.message : 'Invalid terminal frame')
              remote.close()
            }
          })
          remote.on('unexpected-response', (_request, response) => {
            fail(ws, response.statusCode === 403
              ? 'The machine is not accepting requests from other machines'
              : `Could not open the terminal on the machine (HTTP ${response.statusCode})`)
          })
          remote.on('error', () => fail(ws, 'The connection to the machine was lost'))
          remote.on('close', () => {
            if (!closed) try { ws.close() } catch { /* closed */ }
          })
        } catch (error) {
          fail(ws, error instanceof Error ? error.message : 'Could not reach the machine')
        }
      })()
    },
    onMessage(event: MessageEvent, ws: WSContext) {
      void (async () => {
        const data: unknown = event.data
        const text = typeof data === 'string' ? data
          : data instanceof Blob ? await data.text()
            : data instanceof ArrayBuffer ? new TextDecoder().decode(data)
              : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8') : ''
        if (!text) return
        if (send && upstream?.readyState === WebSocket.OPEN) {
          try { send(text) } catch { fail(ws, 'The connection to the machine was lost') }
        } else if (pending.length < 256) {
          pending.push(text)
        }
      })()
    },
    onClose() {
      closed = true
      upstream?.close()
    },
  }
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}
