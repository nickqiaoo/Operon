import { writeOpencodeCallerPlugin } from './caller-identity.js'
import { createTimeoutError, extractErrorMessage } from './errors.js'
import { getLogger } from './logger.js'
import { forgetServer, pidListeningOn, reapOrphanedServers, recordServer } from './server-pidfile.js'
import type { OpencodeLogger } from './types.js'
import type { RuntimeContext } from '../../context.js'
import { startOpencodeServer, type OpencodeServer } from './server.js'

type OpencodeClient = Awaited<ReturnType<typeof import('@opencode-ai/sdk/v2').createOpencodeClient>>

export interface ClientManagerOptions {
  hostname?: string
  /** 0 (the default) lets the OS pick a free port for the server we start. */
  port?: number
  /** Talk to an OpenCode server someone else runs instead of starting one. */
  baseUrl?: string
  autoStartServer?: boolean
  serverTimeout?: number
  cwd?: string
  logger?: OpencodeLogger | false
}

export class OpencodeClientManager {
  private client: OpencodeClient | null = null
  private server: OpencodeServer | null = null
  private serverPid: number | undefined
  private initPromise: Promise<OpencodeClient> | null = null
  private isDisposed = false
  private readonly logger: OpencodeLogger
  private options: Required<Pick<ClientManagerOptions, 'hostname' | 'port' | 'autoStartServer' | 'serverTimeout'>> &
    Omit<ClientManagerOptions, 'hostname' | 'port' | 'autoStartServer' | 'serverTimeout'>

  private constructor(
    private readonly ctx: RuntimeContext,
    options: ClientManagerOptions,
  ) {
    this.options = {
      hostname: options.hostname ?? '127.0.0.1',
      port: options.port ?? 0,
      autoStartServer: options.autoStartServer ?? true,
      serverTimeout: options.serverTimeout ?? 10000,
      baseUrl: options.baseUrl,
      cwd: options.cwd,
      logger: options.logger,
    }
    this.logger = getLogger(options.logger)
  }

  /**
   * The runtime's one manager — one OpenCode server serves every session of a
   * runtime. The first caller's options win, as they always have; it is disposed
   * with the runtime (`RuntimeContext.disposeShared`).
   */
  static getInstance(ctx: RuntimeContext, options?: ClientManagerOptions): OpencodeClientManager {
    return ctx.shared('opencode:client-manager', () => new OpencodeClientManager(ctx, options ?? {}))
  }

  async getClient(): Promise<OpencodeClient> {
    if (this.isDisposed) {
      throw new Error('OpenCode client manager has been disposed')
    }
    if (this.client) return this.client
    if (this.initPromise) return this.initPromise

    this.initPromise = this.initializeClient()
    try {
      this.client = await this.initPromise
      return this.client
    } finally {
      this.initPromise = null
    }
  }

  async listSkills(cwd?: string): Promise<Array<{ name: string; description: string }>> {
    const client = await this.getClient()
    try {
      const result = await (
        client as unknown as {
          app: { skills: (payload: { directory?: string }) => Promise<{ data?: Array<{ name: string; description: string }> }> }
        }
      ).app.skills({ directory: cwd })
      return result.data ?? []
    } catch (error) {
      this.logger.warn(`Failed to list skills: ${extractErrorMessage(error)}`)
      return []
    }
  }

  async dispose(): Promise<void> {
    this.isDisposed = true
    this.client = null
    this.initPromise = null
    if (this.server) {
      this.server.close()
      this.server = null
      forgetServer(this.serverPid)
      this.serverPid = undefined
    }
  }

  private async initializeClient(): Promise<OpencodeClient> {
    const { createOpencodeClient } = await import('@opencode-ai/sdk/v2')

    if (this.options.baseUrl) {
      return createOpencodeClient({
        baseUrl: this.options.baseUrl,
        directory: this.options.cwd,
      })
    }

    if (!this.options.autoStartServer) {
      throw new Error('No OpenCode baseUrl configured and autoStartServer is disabled')
    }

    // Always start our own server, on a port nobody else knows, and never adopt
    // one already running. The server holds MCP endpoints that point at this
    // app's HTTP port, which is new on every launch: a server left over from an
    // earlier launch (or owned by another running instance) answers fine but
    // fails every node_repl call with "Unable to connect". A fixed port made
    // that collision the default; a random one makes it impossible.
    // Leftovers are still stopped here, but only to free the memory.
    reapOrphanedServers(this.logger)

    try {
      this.server = await startOpencodeServer({
        binary: this.ctx.resolveBinary('opencode') ?? 'opencode',
        env: this.ctx.env(),
        hostname: this.options.hostname,
        port: this.options.port,
        timeout: this.options.serverTimeout,
        // Tags first-party MCP calls with the calling session (caller-identity.ts).
        // A server this process did not start lacks it, and those calls fail
        // with a clear error instead of reaching the wrong conversation.
        config: { plugin: [writeOpencodeCallerPlugin()] },
      })
      // Recorded with this process as its owner, so a later launch can stop it
      // if we die without closing it, and leaves it alone while we run.
      this.serverPid = pidListeningOn(Number(new URL(this.server.url).port))
      recordServer(this.serverPid)
      return createOpencodeClient({
        baseUrl: this.server.url,
        directory: this.options.cwd,
      })
    } catch (error) {
      const message = extractErrorMessage(error)
      if (message.includes('Timeout')) {
        throw createTimeoutError(this.options.serverTimeout, 'server startup')
      }
      throw new Error(`Failed to start OpenCode server: ${message}`)
    }
  }
}
