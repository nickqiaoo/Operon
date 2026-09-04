import { createTimeoutError, extractErrorMessage } from './errors.js'
import { getLogger } from './logger.js'
import {
  clearServerPid,
  pidListeningOn,
  reclaimOrphanedServer,
  recordServerPid,
  waitForPortRelease,
} from './server-pidfile.js'
import type { OpencodeLogger } from './types.js'

type OpencodeClient = Awaited<ReturnType<typeof import('@opencode-ai/sdk/v2').createOpencodeClient>>
type OpencodeServer = Awaited<ReturnType<typeof import('@opencode-ai/sdk/v2').createOpencodeServer>>

export interface ClientManagerOptions {
  hostname?: string
  port?: number
  baseUrl?: string
  autoStartServer?: boolean
  serverTimeout?: number
  cwd?: string
  logger?: OpencodeLogger | false
}

export class OpencodeClientManager {
  private static instance: OpencodeClientManager | null = null
  private client: OpencodeClient | null = null
  private server: OpencodeServer | null = null
  private initPromise: Promise<OpencodeClient> | null = null
  private isDisposed = false
  private readonly logger: OpencodeLogger
  private options: Required<Pick<ClientManagerOptions, 'hostname' | 'port' | 'autoStartServer' | 'serverTimeout'>> &
    Omit<ClientManagerOptions, 'hostname' | 'port' | 'autoStartServer' | 'serverTimeout'>

  private constructor(options: ClientManagerOptions) {
    this.options = {
      hostname: options.hostname ?? '127.0.0.1',
      port: options.port ?? 4096,
      autoStartServer: options.autoStartServer ?? true,
      serverTimeout: options.serverTimeout ?? 10000,
      baseUrl: options.baseUrl,
      cwd: options.cwd,
      logger: options.logger,
    }
    this.logger = getLogger(options.logger)
  }

  static getInstance(options?: ClientManagerOptions): OpencodeClientManager {
    if (!OpencodeClientManager.instance) {
      OpencodeClientManager.instance = new OpencodeClientManager(options ?? {})
    }
    return OpencodeClientManager.instance
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
      clearServerPid(this.options.port)
    }
  }

  private async initializeClient(): Promise<OpencodeClient> {
    const { createOpencodeClient, createOpencodeServer } = await import('@opencode-ai/sdk/v2')

    if (this.options.baseUrl) {
      return createOpencodeClient({
        baseUrl: this.options.baseUrl,
        directory: this.options.cwd,
      })
    }

    const serverUrl = `http://${this.options.hostname}:${this.options.port}`
    if (await this.isServerRunning(serverUrl)) {
      // A server on the port is not automatically one we may talk to. If a
      // previous run of this app left it behind, its MCP endpoints still point
      // at that run's HTTP port, which died with it — reusing it yields a
      // session where every node_repl call reports "Unable to connect". Take
      // the orphan down and start clean; a server the user started by hand has
      // no pid record and is reused exactly as before.
      const reclaimed = this.options.autoStartServer && reclaimOrphanedServer(this.options.port, this.logger)
      const released =
        reclaimed && (await waitForPortRelease(() => this.isServerRunning(serverUrl)))
      if (!reclaimed || !released) {
        if (reclaimed) {
          this.logger.warn(
            `Orphaned OpenCode server on port ${this.options.port} did not exit; reusing it. MCP endpoints may be stale.`,
          )
        }
        return createOpencodeClient({ baseUrl: serverUrl, directory: this.options.cwd })
      }
    }

    if (!this.options.autoStartServer) {
      throw new Error(`No OpenCode server running at ${serverUrl} and autoStartServer is disabled`)
    }

    try {
      this.server = await createOpencodeServer({
        hostname: this.options.hostname,
        port: this.options.port,
        timeout: this.options.serverTimeout,
      })
      // Recorded so the next launch can tell this process apart from one the
      // user started, and reclaim only this one.
      recordServerPid(this.options.port, pidListeningOn(this.options.port))
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

  private async isServerRunning(baseUrl: string): Promise<boolean> {
    try {
      const health = await fetch(`${baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      })
      if (health.ok) return true
    } catch {}

    try {
      const config = await fetch(`${baseUrl}/config`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      })
      return config.ok
    } catch {
      return false
    }
  }
}
