// Wire frames, mirrored from the Go broker.
// Headers travel as Record<string, string[]> to preserve multi-value (e.g. Set-Cookie).

export interface WelcomeFrame {
  t: 'welcome'
  connId: string
  sessionId: string
  userId: string
  nodeId: string
  heartbeatMs: number
  maxInlineBody: number
}

export interface PingFrame {
  t: 'ping'
  ts: number
}

export interface ReqFrame {
  t: 'req'
  id: string
  method: string
  path: string
  query?: string
  headers?: Record<string, string[]>
  body?: string
  enc?: string
}

export interface CancelFrame {
  t: 'cancel'
  id: string
  reason?: string
}

export interface CloseFrame {
  t: 'close'
  code: string
  message?: string
}

// --- raw WebSocket tunnel (Phase 4), protocol §2.7 ---

export interface WSOpenFrame {
  t: 'ws-open'
  id: string
  path: string
  query?: string
  headers?: Record<string, string[]>
}

export interface WSMsgFrame {
  t: 'ws-msg'
  id: string
  data: string
  enc?: string
}

export interface WSCloseFrame {
  t: 'ws-close'
  id: string
  wsCode?: number
  reason?: string
}

/** Anything the broker may send. The catch-all `{ t: string }` keeps JSON.parse typed. */
export type InboundFrame =
  | WelcomeFrame
  | PingFrame
  | ReqFrame
  | CancelFrame
  | CloseFrame
  | WSOpenFrame
  | WSMsgFrame
  | WSCloseFrame
  | { t: string }

/** Anything the agent sends back. */
export type OutboundFrame =
  | { t: 'hello'; protocol: number; agent: string; auth: string; nodeId: string; label: string; caps: string[] }
  | { t: 'pong'; ts: number }
  | { t: 'res-head'; id: string; status: number; headers: Record<string, string[]> }
  | { t: 'res-chunk'; id: string; data: string; enc?: string }
  | { t: 'res-end'; id: string }
  | { t: 'res-error'; id: string; status?: number; code: string; message: string }
  | { t: 'ws-ack'; id: string; ok: boolean; code?: string }
  | { t: 'ws-msg'; id: string; data: string; enc?: string }
  | { t: 'ws-close'; id: string; wsCode?: number; reason?: string }

export type Send = (f: OutboundFrame) => void

/** Decode a req body string back to bytes/text for fetch (mirrors broker encodeBytes). */
export function decodeBody(body: string | undefined, enc: string | undefined): string | Uint8Array | undefined {
  if (body === undefined || body === '') return undefined
  if (enc === 'base64') return new Uint8Array(Buffer.from(body, 'base64'))
  return body
}
