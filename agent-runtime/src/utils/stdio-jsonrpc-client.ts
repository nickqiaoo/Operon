import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

interface JsonRpcSuccessResponse {
  jsonrpc: '2.0'
  id: string | null
  result: unknown
}

interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  id: string | null
  error: JsonRpcErrorObject
}

interface JsonRpcRequestMessage {
  jsonrpc: '2.0'
  id: string
  method: string
  params?: unknown
}

interface JsonRpcNotificationMessage {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

type JsonRpcIncomingMessage =
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse
  | JsonRpcRequestMessage
  | JsonRpcNotificationMessage

type PendingResponse = {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(typeof value === 'string' ? value : 'Unknown JSON-RPC error')

function isJsonRpcErrorObject(value: unknown): value is JsonRpcErrorObject {
  return isRecord(value) && typeof value.code === 'number' && typeof value.message === 'string'
}

export class JsonRpcRequestError extends Error {
  readonly code: number
  readonly data?: unknown
  readonly method: string
  readonly requestId: string

  constructor(params: {
    code: number
    data?: unknown
    message: string
    method: string
    requestId: string
  }) {
    super(params.message)
    this.name = 'JsonRpcRequestError'
    this.code = params.code
    this.data = params.data
    this.method = params.method
    this.requestId = params.requestId
  }
}

function parseIncomingMessage(value: unknown): JsonRpcIncomingMessage | null {
  if (!isRecord(value)) return null
  if (value.jsonrpc !== '2.0') return null

  const id = typeof value.id === 'string' ? value.id : value.id === null ? null : undefined
  const method = typeof value.method === 'string' ? value.method : undefined

  if (method && id) {
    return {
      jsonrpc: '2.0',
      id,
      method,
      ...(Object.prototype.hasOwnProperty.call(value, 'params') ? { params: value.params } : {}),
    }
  }

  if (method && id === undefined) {
    return {
      jsonrpc: '2.0',
      method,
      ...(Object.prototype.hasOwnProperty.call(value, 'params') ? { params: value.params } : {}),
    }
  }

  if (!method && id !== undefined && Object.prototype.hasOwnProperty.call(value, 'result')) {
    return {
      jsonrpc: '2.0',
      id,
      result: value.result,
    }
  }

  if (!method && id !== undefined && isJsonRpcErrorObject(value.error)) {
    return {
      jsonrpc: '2.0',
      id,
      error: value.error,
    }
  }

  return null
}

export interface StdioJsonRpcClientOptions {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  onNotification?: (message: JsonRpcNotificationMessage) => void | Promise<void>
  onRequest?: (message: JsonRpcRequestMessage) => Promise<unknown>
  onStderrLine?: (line: string) => void
  onExit?: (error: Error) => void
}

export class StdioJsonRpcClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pendingResponses = new Map<string, PendingResponse>()
  private readonly exitPromise: Promise<void>
  private closed = false
  private closing = false

  constructor(private readonly options: StdioJsonRpcClientOptions) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
    })

    const stdout = createInterface({ input: this.child.stdout })
    stdout.on('line', (line) => {
      void this.handleStdoutLine(line)
    })

    const stderr = createInterface({ input: this.child.stderr })
    stderr.on('line', (line) => {
      this.options.onStderrLine?.(line)
    })

    this.exitPromise = new Promise((resolve) => {
      let settled = false
      const finalize = (error: Error) => {
        if (settled) return
        settled = true
        this.closed = true
        this.rejectAllPending(error)
        if (!this.closing) {
          this.options.onExit?.(error)
        }
        resolve()
      }

      this.child.once('error', (error) => {
        finalize(toError(error))
      })

      this.child.once('exit', (code, signal) => {
        finalize(
          new Error(
            `JSON-RPC process exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (signal ${signal})` : ''}`,
          ),
        )
      })
    })
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      throw new Error('JSON-RPC client is closed')
    }

    const id = randomUUID()
    const message: JsonRpcRequestMessage = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }

    const responsePromise = new Promise<unknown>((resolve, reject) => {
      this.pendingResponses.set(id, { method, resolve, reject })
    })

    this.writeMessage(message)
    return responsePromise
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    const message: JsonRpcNotificationMessage = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    }
    this.writeMessage(message)
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) {
      await this.exitPromise
      return
    }

    this.closing = true
    try {
      this.child.stdin.end()
    } catch {
      // best effort
    }
    try {
      this.child.kill()
    } catch {
      // best effort
    }
    await this.exitPromise
  }

  private writeMessage(message: JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    const payload = JSON.stringify(message)
    this.child.stdin.write(`${payload}\n`)
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingResponses.values()) {
      pending.reject(error)
    }
    this.pendingResponses.clear()
  }

  private async handleStdoutLine(line: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch (error) {
      this.options.onStderrLine?.(`[jsonrpc] Failed to parse stdout line: ${toError(error).message}`)
      return
    }

    const message = parseIncomingMessage(parsed)
    if (!message) {
      this.options.onStderrLine?.('[jsonrpc] Ignored malformed JSON-RPC message')
      return
    }

    if ('method' in message && 'id' in message) {
      await this.handleRequest(message)
      return
    }

    if ('method' in message) {
      await this.options.onNotification?.(message)
      return
    }

    this.handleResponse(message)
  }

  private handleResponse(message: JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    if (message.id === null) return
    const pending = this.pendingResponses.get(message.id)
    if (!pending) return
    this.pendingResponses.delete(message.id)

    if ('error' in message) {
      pending.reject(
        new JsonRpcRequestError({
          code: message.error.code,
          data: message.error.data,
          message: message.error.message,
          method: pending.method,
          requestId: message.id,
        }),
      )
      return
    }

    pending.resolve(message.result)
  }

  private async handleRequest(message: JsonRpcRequestMessage): Promise<void> {
    if (!this.options.onRequest) {
      this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported request method: ${message.method}`,
        },
      })
      return
    }

    try {
      const result = await this.options.onRequest(message)
      this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        result,
      })
    } catch (error) {
      const normalized = toError(error)
      this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: normalized.message,
        },
      })
    }
  }
}
