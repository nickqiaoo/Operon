import WebSocket, { type RawData } from 'ws'
import { decodeBody, type Send, type WSOpenFrame } from './frames.js'

// wsForward tunnels a browser WebSocket (relayed by the broker as a ws-open/ws-msg/
// ws-close stream) to the matching local backend WS — e.g. /api/terminal/ws. One
// LocalWS per stream id; messages pipe both ways until either side closes. See
// protocol §2.7.

export interface LocalWS {
  /** Forward a browser→local message (queued until the local WS opens). */
  send(data: string | Uint8Array): void
  /** Close the local WS (broker-initiated teardown). */
  close(): void
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data as ArrayBuffer)
}

/** Dial the local WS for a ws-open and start piping. Registers into `streams`. */
export function handleWSOpen(
  f: WSOpenFrame,
  send: Send,
  localBase: string,
  streams: Map<string, LocalWS>,
  localToken?: string,
): void {
  const id = f.id
  const url = localBase.replace(/^http/, 'ws') + f.path + (f.query ?? '')
  const local = new WebSocket(url, {
    headers: {
      'x-operon-remote-tunnel': '1',
      ...(localToken ? { 'x-operon-token': localToken } : {}),
    },
  })
  const queue: Array<string | Uint8Array> = []
  let open = false

  streams.set(id, {
    send(data) {
      if (open && local.readyState === WebSocket.OPEN) {
        local.send(data)
      } else {
        queue.push(data)
      }
    },
    close() {
      try {
        local.close()
      } catch {
        // ignore
      }
    },
  })

  local.on('open', () => {
    open = true
    send({ t: 'ws-ack', id, ok: true })
    for (const m of queue) {
      try {
        local.send(m)
      } catch {
        // ignore
      }
    }
    queue.length = 0
  })

  local.on('message', (data: RawData, isBinary: boolean) => {
    const buf = toBuffer(data)
    if (isBinary) {
      send({ t: 'ws-msg', id, data: buf.toString('base64'), enc: 'base64' })
    } else {
      send({ t: 'ws-msg', id, data: buf.toString('utf-8') })
    }
  })

  local.on('close', (code: number, reason: Buffer) => {
    // Only report if WE still own the stream — a broker-initiated close already
    // removed it and is tearing the browser side down.
    if (streams.delete(id)) {
      send({ t: 'ws-close', id, wsCode: code || 1000, reason: reason.toString('utf-8') })
    }
  })

  local.on('error', (err: Error) => {
    // A failure before open means the local WS was never reachable; tell the broker so
    // it closes the browser side. A post-open error is followed by 'close'.
    if (!open && streams.delete(id)) {
      send({ t: 'ws-ack', id, ok: false, code: 'local_unreachable' })
      send({ t: 'ws-close', id, wsCode: 1011, reason: err.message })
    }
  })
}

/** Forward a broker→local ws-msg into the open (or queued) local WS. */
export function handleWSMsg(
  id: string,
  data: string | undefined,
  enc: string | undefined,
  streams: Map<string, LocalWS>,
): void {
  const decoded = decodeBody(data, enc)
  if (decoded !== undefined) streams.get(id)?.send(decoded)
}

/** Broker asked to close this stream: drop it and close the local WS. */
export function handleWSClose(id: string, streams: Map<string, LocalWS>): void {
  const holder = streams.get(id)
  if (holder) {
    streams.delete(id)
    holder.close()
  }
}

/** Tear down every local WS (connection drop / agent stop). */
export function closeAllWS(streams: Map<string, LocalWS>): void {
  for (const holder of streams.values()) holder.close()
  streams.clear()
}
