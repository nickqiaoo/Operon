import { decodeBody, type ReqFrame, type Send } from './frames.js'

// handleReq replays one tunneled request against the local backend and streams the
// response back as res-head / res-chunk* / res-end (or res-error). PoC: always
// stream — never buffer to completion (protocol §4 of the PoC plan).

export async function handleReq(
  f: ReqFrame,
  send: Send,
  localBase: string,
  inflight: Map<string, AbortController>,
  localToken?: string,
): Promise<void> {
  const ac = new AbortController()
  inflight.set(f.id, ac)
  try {
    const headers = buildHeaders(f.headers)
    // Force identity encoding: gzip-through-tunnel would double-handle compression.
    headers.delete('accept-encoding')
    // This header is created by the trusted tunnel agent, never forwarded from
    // the browser. The local server uses it to distinguish remote traffic from
    // loopback Electron traffic before applying its E2EE policy.
    headers.delete('x-operon-remote-tunnel')
    headers.set('x-operon-remote-tunnel', '1')
    // Same trust rule as the tunnel marker: the local-backend token is minted
    // here, never forwarded from the browser — strip any client-sent value.
    headers.delete('x-operon-token')
    if (localToken) headers.set('x-operon-token', localToken)

    const url = localBase + f.path + (f.query ?? '')
    const body = toFetchBody(decodeBody(f.body, f.enc))
    const init: RequestInit & { duplex?: 'half' } = {
      method: f.method,
      headers,
      body,
      signal: ac.signal,
      duplex: body ? 'half' : undefined,
    }
    const res = await fetch(url, init)

    send({ t: 'res-head', id: f.id, status: res.status, headers: dumpHeaders(res.headers) })

    if (res.body) {
      const textual = isTextual(res.headers.get('content-type'))
      // Streaming UTF-8 decoder holds back partial multibyte chars across chunk
      // boundaries, so each emitted string is valid UTF-8 and reassembles exactly.
      const decoder = textual ? new TextDecoder('utf-8') : null
      const reader = res.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value && value.length > 0) {
          if (decoder) {
            send({ t: 'res-chunk', id: f.id, data: decoder.decode(value, { stream: true }) })
          } else {
            send({ t: 'res-chunk', id: f.id, data: Buffer.from(value).toString('base64'), enc: 'base64' })
          }
        }
      }
      if (decoder) {
        const tail = decoder.decode()
        if (tail) send({ t: 'res-chunk', id: f.id, data: tail })
      }
    }

    send({ t: 'res-end', id: f.id })
  } catch (err) {
    if (ac.signal.aborted) return // cancel already propagated; nothing more to send
    send({
      t: 'res-error',
      id: f.id,
      status: 502,
      code: 'local_unreachable',
      message: err instanceof Error ? err.message : String(err),
    })
  } finally {
    inflight.delete(f.id)
  }
}

function buildHeaders(rec?: Record<string, string[]>): Headers {
  const h = new Headers()
  if (rec) {
    for (const [k, vals] of Object.entries(rec)) {
      for (const v of vals) h.append(k, v)
    }
  }
  return h
}

function toFetchBody(body: string | Uint8Array | undefined): RequestInit['body'] {
  if (body === undefined) return undefined
  if (typeof body === 'string') return body
  const buffer = new ArrayBuffer(body.byteLength)
  new Uint8Array(buffer).set(body)
  return buffer
}

function dumpHeaders(h: Headers): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  h.forEach((value, key) => {
    out[key] = [value]
  })
  const getSetCookie = (h as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const cookies = getSetCookie?.call(h)
  if (cookies && cookies.length > 0) out['set-cookie'] = cookies
  return out
}

function isTextual(contentType: string | null): boolean {
  if (!contentType) return false
  return /^text\/|json|event-stream|xml|javascript/i.test(contentType)
}
