import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { Readable, Transform, Writable } from 'node:stream'
import * as acp from '@zed-industries/agent-client-protocol'
import { logProviderRaw } from '../../provider-raw-log.js'

/** ACP protocol version negotiated on `initialize` (v1 is current). */
export const ACP_PROTOCOL_VERSION = 1

/**
 * Proprietary `session/update` variants some agents emit (e.g. cursor-agent's
 * `session_info_update` title) that aren't in the ACP schema. The SDK rejects
 * unknown variants with a noisy per-turn `console.error`, so we drop these lines
 * before they reach its parser. Conservative blacklist — only known-proprietary
 * variants, never a real one, so a future SDK bump can't be starved.
 */
const DROPPED_SESSION_UPDATES = new Set(['session_info_update'])

function shouldDropLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  try {
    const msg = JSON.parse(trimmed) as { method?: unknown; params?: { update?: { sessionUpdate?: unknown } } }
    if (msg.method === 'session/update') {
      const variant = msg.params?.update?.sessionUpdate
      return typeof variant === 'string' && DROPPED_SESSION_UPDATES.has(variant)
    }
  } catch {
    // Unparseable line — leave it for the SDK to handle/report.
  }
  return false
}

/** Newline-delimited passthrough that drops proprietary notification lines. */
function createNotificationFilter(): Transform {
  let buffer = ''
  return new Transform({
    transform(chunk, _enc, cb) {
      buffer += chunk.toString('utf8')
      let out = ''
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index + 1)
        buffer = buffer.slice(index + 1)
        if (!shouldDropLine(line)) out += line
      }
      cb(null, out)
    },
    flush(cb) {
      cb(null, buffer && !shouldDropLine(buffer) ? buffer : '')
    },
  })
}

export interface AcpConnectionCallbacks {
  onSessionUpdate(params: acp.SessionNotification): void
  onRequestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>
  onExit(error?: Error): void
  onStderr?(line: string): void
}

export interface AcpConnectionOptions {
  providerId: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  callbacks: AcpConnectionCallbacks
}

/**
 * The client half of an ACP connection over a spawned CLI's stdio. Uses the
 * official `@zed-industries/agent-client-protocol` SDK for all JSON-RPC framing
 * and correlation; we only implement the two required `Client` callbacks
 * (`sessionUpdate`, `requestPermission`) and drive the agent via `this.agent`.
 */
export class AcpConnection {
  readonly agent: acp.Agent
  private readonly proc: ChildProcessWithoutNullStreams
  private exited = false

  constructor(private readonly options: AcpConnectionOptions) {
    this.proc = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // `node:stream/web` streams are structurally the web streams the SDK wants,
    // but resolve to a different `ReadableStream`/`WritableStream` type than the
    // ambient one under DOM lib. Cast through the SDK's own parameter types so
    // this compiles under both the node-only and DOM tsconfigs.
    const filteredStdout = this.proc.stdout.pipe(createNotificationFilter())
    const input = Readable.toWeb(filteredStdout) as unknown as Parameters<typeof acp.ndJsonStream>[1]
    const output = Writable.toWeb(this.proc.stdin) as unknown as Parameters<typeof acp.ndJsonStream>[0]
    const stream = acp.ndJsonStream(output, input)

    this.agent = new acp.ClientSideConnection(() => this.createClient(), stream)

    this.wireStderr()
    this.proc.on('error', (error) => this.handleExit(error))
    this.proc.on('exit', (code, signal) => {
      if (code === 0 || code === null) {
        this.handleExit(signal ? new Error(`${options.providerId} agent terminated by signal ${signal}`) : undefined)
      } else {
        this.handleExit(new Error(`${options.providerId} agent exited with code ${code}`))
      }
    })
  }

  private createClient(): acp.Client {
    return {
      sessionUpdate: async (params) => {
        logProviderRaw(this.options.providerId, { dir: 'notify', method: 'session/update', params })
        this.options.callbacks.onSessionUpdate(params)
      },
      requestPermission: async (params) => {
        logProviderRaw(this.options.providerId, { dir: 'request', method: 'session/request_permission', params })
        return this.options.callbacks.onRequestPermission(params)
      },
    }
  }

  private wireStderr(): void {
    let buffer = ''
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk: string) => {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim()) this.options.callbacks.onStderr?.(line)
      }
    })
  }

  private handleExit(error?: Error): void {
    if (this.exited) return
    this.exited = true
    this.options.callbacks.onExit(error)
  }

  async dispose(): Promise<void> {
    this.exited = true
    if (!this.proc.killed) {
      this.proc.kill('SIGTERM')
    }
  }
}
