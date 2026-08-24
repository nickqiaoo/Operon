import { handleReq } from './forward.js'
import { Uploader } from './uploader.js'
import {
  closeAllWS,
  handleWSClose,
  handleWSMsg,
  handleWSOpen,
  type LocalWS,
} from './wsForward.js'
import type {
  CancelFrame,
  CloseFrame,
  InboundFrame,
  OutboundFrame,
  ReqFrame,
  WelcomeFrame,
  WSCloseFrame,
  WSMsgFrame,
  WSOpenFrame,
} from './frames.js'

export interface AgentOptions {
  /** Broker HTTP(S) base, e.g. https://broker.example.com (no trailing path). */
  brokerUrl: string
  secret: string
  nodeId: string
  label: string
  localBase: string
  /**
   * Startup token of the local backend (server/src/services/api-token.ts).
   * Attached to every forwarded request/WS so tunneled traffic passes the
   * /api/* token gate. The embedded caller passes it in-process; a standalone
   * agent reads it from ~/.operon/run/api-token.
   */
  localToken?: string
  /**
   * The broker refused this token — it is revoked, or was minted by a different
   * broker than the one this build talks to. Reconnecting cannot fix either, so
   * the agent stops; this is how the embedded caller learns that the silence is
   * permanent and the user has to sign in again.
   */
  onAuthRejected?: () => void
}

const MAX_BACKOFF_MS = 15_000

/** Handle to stop an embedded agent (e.g. on logout, when run in-process). */
export interface AgentHandle {
  stop(): void
}

// startAgent keeps the node↔broker tunnel up over HTTP — an SSE downlink for frames
// from the broker, and discrete batched POSTs for frames back — reconnecting with
// backoff. (No WebSocket: proxies mangle the upgrade. No streaming uplink body
// either: CDNs buffer request bodies whole, so an endless one never arrives.)
//
// Each attempt owns a fresh in-flight map, so a drop releases the previous attempt's
// requests. Their ids belong to a dead connection and their output has nowhere to go,
// but the LOCAL work continues — see the note in teardown().
export function startAgent(opts: AgentOptions): AgentHandle {
  let stopped = false
  let backoff = 500
  let current: AbortController | null = null

  const connect = async (): Promise<void> => {
    const ac = new AbortController()
    current = ac
    const inflight = new Map<string, AbortController>()
    const wsStreams = new Map<string, LocalWS>()

    // Uplink: discrete batched POSTs (see uploader.ts). It only exists once `welcome`
    // hands us a connId, so frames produced before then wait in `preWelcome` — in
    // practice nothing does, since work only arrives in response to broker frames.
    let uploader: Uploader | null = null
    const preWelcome: OutboundFrame[] = []
    const send = (f: OutboundFrame): void => {
      if (uploader) uploader.enqueue(f)
      else preWelcome.push(f)
    }

    let torn = false
    const teardown = (): void => {
      if (torn) return
      torn = true
      // Aborting the local fetches stops US reading them; it does not kill the work
      // behind them. Chat turns in particular run to completion and persist locally
      // (server/src/routes/ai.ts deliberately ignores the request signal), so a
      // tunnel drop costs a re-attach, never a lost turn.
      for (const a of inflight.values()) a.abort()
      inflight.clear()
      closeAllWS(wsStreams)
      uploader?.stop()
      uploader = null
      try {
        ac.abort()
      } catch {
        // ignore
      }
    }

    const dispatch = (f: InboundFrame): void => {
      switch (f.t) {
        case 'ping':
          // No reply. The ping's job is to force a periodic write on the broker's SSE
          // downlink so a dead socket surfaces; uplink liveness rides on the batches
          // themselves, including the uploader's idle keepalive. Ponging every ping
          // would cost an HTTP request per node per 15s for no added signal.
          break
        case 'req':
          void handleReq(f as ReqFrame, send, opts.localBase, inflight, opts.localToken)
          break
        case 'cancel': {
          const id = (f as CancelFrame).id
          inflight.get(id)?.abort()
          inflight.delete(id)
          break
        }
        case 'ws-open':
          handleWSOpen(f as WSOpenFrame, send, opts.localBase, wsStreams, opts.localToken)
          break
        case 'ws-msg': {
          const m = f as WSMsgFrame
          handleWSMsg(m.id, m.data, m.enc, wsStreams)
          break
        }
        case 'ws-close':
          handleWSClose((f as WSCloseFrame).id, wsStreams)
          break
        case 'close': {
          const c = f as CloseFrame
          console.warn(`[agent] broker closed: ${c.code} ${c.message ?? ''}`)
          if (
            c.code === 'superseded' ||
            c.code === 'unauthorized' ||
            c.code === 'unsupported_version' ||
            c.code === 'revoked'
          ) {
            stopped = true
            if (c.code === 'unauthorized' || c.code === 'revoked') opts.onAuthRejected?.()
          }
          break
        }
        default:
          break
      }
    }

    // The front router (OpenResty) routes every uplink POST to the instance holding
    // this connId's downlink. onFatal fires only for statuses that mean the
    // connection is gone (403/404/409) — transient failures are retried forever
    // inside the uploader rather than surfacing here.
    const startUp = (connId: string): void => {
      uploader = new Uploader({
        brokerUrl: opts.brokerUrl,
        secret: opts.secret,
        connId,
        signal: ac.signal,
        onFatal: () => teardown(),
      })
      for (const f of preWelcome.splice(0)) uploader.enqueue(f)
    }

    try {
      // 1) Open the SSE downlink.
      const downRes = await fetch(
        `${opts.brokerUrl}/agent/down?label=${encodeURIComponent(opts.label)}`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${opts.secret}`, accept: 'text/event-stream' },
          signal: ac.signal,
        },
      )
      if (!downRes.ok || !downRes.body) {
        if (downRes.status === 401 || downRes.status === 403) {
          stopped = true
          opts.onAuthRejected?.()
        }
        throw new Error(`downlink failed: ${downRes.status}`)
      }
      backoff = 500

      // 2) Read SSE events; the first is `welcome` (carries connId) → open the uplink.
      let upStarted = false
      const reader = downRes.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          const data = parseSSEData(block)
          if (data === null) continue
          let f: InboundFrame
          try {
            f = JSON.parse(data) as InboundFrame
          } catch {
            continue
          }
          if (f.t === 'welcome') {
            const w = f as WelcomeFrame
            console.log(`[agent] connected as user=${w.userId} node=${w.nodeId}`)
            if (w.connId && !upStarted) {
              upStarted = true
              startUp(w.connId)
            }
            continue
          }
          dispatch(f)
        }
      }
      // downlink ended → connection is over
    } catch (err) {
      if (!ac.signal.aborted) {
        console.error(`[agent] connection error: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      teardown()
      if (!stopped) scheduleReconnect()
    }
  }

  const scheduleReconnect = (): void => {
    const jitter = Math.floor(backoff * 0.3 * Math.random())
    const delay = backoff + jitter
    console.log(`[agent] reconnecting in ${delay}ms`)
    setTimeout(() => void connect(), delay)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }

  void connect()

  return {
    stop(): void {
      stopped = true
      try {
        current?.abort()
      } catch {
        // ignore
      }
    },
  }
}

/** Extract the joined `data:` payload from one SSE event block (ignores comments). */
function parseSSEData(block: string): string | null {
  const parts: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) {
      parts.push(line.slice(line.startsWith('data: ') ? 6 : 5))
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}
