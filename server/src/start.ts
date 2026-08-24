import { serve } from '@hono/node-server'
import {
  createServer as httpCreateServer,
  type Server as HttpServer,
  type ServerOptions as HttpServerOptions,
  type RequestListener,
} from 'node:http'
import type { Socket } from 'node:net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SqliteStorage } from './storage/sqlite.js'
import { migrateInlineAttachmentsOnce } from './services/attachment-migration.js'
import { startCronjobScheduler } from './services/cronjob-scheduler.js'
import { createApp } from './app.js'
import { getProviders, warmAllProviders } from './services/ai.js'
import { getEmbeddingConfig } from './services/vector/embeddings.js'
import { SqliteVecStore } from './services/vector/sqlite-vec-store.js'
import { getLocalLLM } from './services/vector/local-llm.js'
import { MemoryService } from './services/memory/index.js'
import { startMemoryMaintenanceScheduler } from './services/memory-maintenance/scheduler.js'
import { startSaasRuntime } from './services/saas-runtime.js'
import { setTelemetrySink } from './services/analytics/cache-monitor.js'
import { isApiTokenAuthDisabled, publishApiToken } from './services/api-token.js'
import {
  setComputerUsePresentationSink,
} from './services/computer-use-presentation.js'
import type { ComputerUsePresentationEvent } from '@operon/computer-use'
import type { RemoteE2EEMode } from '@shared/e2ee/protocol'

declare const __ENABLE_MEMORY__: boolean

export interface StartServerOptions {
  dbPath: string
  migrationsDir: string
  port: number
  hostname?: string
  /** Analytics sink (backed by the main-process posthog-node). Omitted in headless/test runs. */
  captureAnalytics?: (event: string, properties: Record<string, unknown>) => void
  /** App version, attached to analytics events for per-release regression attribution. */
  appVersion?: string
  /** Latest Computer Use target snapshot for the desktop preview window. */
  onComputerUsePresentationEvent?: (event: ComputerUsePresentationEvent) => void
  /** Remote clients require E2EE unless an unpackaged developer explicitly opts out. */
  remoteE2eeMode?: RemoteE2EEMode
}

export interface ServerInstance {
  port: number
  storage: SqliteStorage
}

interface PublishedServerInfo {
  port: number
  url: string
  pid: number
  updatedAt: string
}

const discoveryFilePath = path.join(os.homedir(), '.operon', 'plugin-server.json')

function publishServerInfo(port: number, hostname: string) {
  const host = hostname === '0.0.0.0' ? '127.0.0.1' : hostname
  const payload: PublishedServerInfo = {
    port,
    url: `http://${host}:${port}`,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  }

  fs.mkdirSync(path.dirname(discoveryFilePath), { recursive: true })
  fs.writeFileSync(discoveryFilePath, JSON.stringify(payload, null, 2))
}

/**
 * One-time tightening of secret-bearing files written 644 by earlier builds
 * (their writers now create them 0600, but only a write fixes an existing
 * file). The db files are handled by SqliteStorage itself.
 */
function tightenLegacyFileModes() {
  for (const p of [
    path.join(os.homedir(), '.operon', 'saas.json'),
    path.join(os.homedir(), '.operon', 'data', 'mcp-servers.json'),
  ]) {
    try {
      fs.chmodSync(p, 0o600)
    } catch {
      // absent — nothing to tighten
    }
  }
}

export async function startServer(options: StartServerOptions): Promise<ServerInstance> {
  const { dbPath, migrationsDir, port, hostname = '127.0.0.1' } = options
  setComputerUsePresentationSink(options.onComputerUsePresentationEvent)

  if (options.captureAnalytics) {
    setTelemetrySink(options.captureAnalytics, options.appVersion)
  }

  tightenLegacyFileModes()
  const storage = new SqliteStorage(dbPath, { migrationsDir })

  // Pull inline attachment bytes out of old transcripts. Deferred rather than
  // awaited: it only ever runs to completion once, and a transcript it hasn't
  // reached yet still renders from its data URL — so there's no reason to hold
  // the port closed for it.
  setImmediate(() => {
    try {
      migrateInlineAttachmentsOnce(storage.getDatabase(), storage)
    } catch (err) {
      // Never fatal — the pre-migration representation still works.
      console.warn('[attachments] inline migration failed:', err)
    }
  })

  const remoteE2eeMode = options.remoteE2eeMode
    ?? (process.env.OPERON_REMOTE_E2EE === 'off' ? 'off' : 'required')
  const { app, injectWebSocket } = await createApp({ storage, remoteE2eeMode })

  if (__ENABLE_MEMORY__) {
    try {
      const ec = getEmbeddingConfig()
      if (ec?.enabled) {
        SqliteVecStore.init()
        const llm = getLocalLLM()
        llm.pullModels().catch((err) => {
          console.error('[Startup] Model download failed:', err)
        })
      }
    } catch {
      // vector search optional
    }
    try {
      MemoryService.init(storage.getDatabase())
      console.log('[Startup] MemoryService initialized')
    } catch (err) {
      console.error('[Startup] MemoryService init failed:', err)
    }
  }

  // Start cronjob scheduler
  startCronjobScheduler(storage)

  if (__ENABLE_MEMORY__) {
    startMemoryMaintenanceScheduler(storage)
  }

  return new Promise<ServerInstance>((resolve) => {
    // Custom createServer so we hold the exact http.Server instance and can
    // attach clientError handling before the WebSocket wrapper is injected.
    const customCreateServer = (opts: HttpServerOptions, listener?: RequestListener): HttpServer => {
      const srv = httpCreateServer(opts, listener)
      srv.on('clientError', (err: NodeJS.ErrnoException & { rawPacket?: Buffer }, socket: Socket) => {
        // Benign disconnects: the client cancelled an in-flight request (e.g.
        // React Query aborting on unmount/refetch). No rawPacket, nothing to
        // diagnose — skip the noise but still close the socket cleanly.
        const benign = err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ECONNABORTED'
        if (!benign) {
          const raw = err.rawPacket ? err.rawPacket.toString('latin1').slice(0, 200) : '(none)'
          console.error(`[http clientError] code=${err.code} msg=${err.message} raw=${JSON.stringify(raw)}`)
        }
        if (!socket.destroyed && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      })
      return srv
    }

    const server = serve(
      {
        fetch: app.fetch,
        port,
        hostname,
        // Codex's Rust `rmcp` HTTP client emits a request Node's strict llhttp
        // parser rejected; the lenient parser accepts it. Safe: we bind 127.0.0.1.
        serverOptions: { insecureHTTPParser: true },
        createServer: customCreateServer as typeof httpCreateServer,
      },
      (info) => {
        // Expose actual port so MCP URL in ai.ts resolves correctly (port may be 0 / dynamic)
        process.env.OPERON_PORT = String(info.port)
        publishServerInfo(info.port, hostname)
        // The discovery file is world-readable on purpose (the port is not a
        // secret); the token goes to ~/.operon/run (0700) for out-of-process
        // local consumers: the standalone tunnel agent and the Chrome-extension
        // native host.
        if (!isApiTokenAuthDisabled()) {
          try {
            publishApiToken()
          } catch (err) {
            console.warn('[auth] failed to publish api token file:', err)
          }
        }
        console.log(`OPERON server running on http://${hostname}:${info.port}`)
        // If the user has already signed in to the SaaS, bring the tunnel up now.
        startSaasRuntime()
        resolve({ port: info.port, storage })
        // The Electron main window is created after startServer() resolves.
        // Defer provider warm-up to the next event-loop turn so model discovery
        // cannot extend the startup logo or delay the first window.
        if (process.env.NODE_ENV !== 'test') {
          setImmediate(() => {
            const availableProviderIds = getProviders()
              .filter((provider) => provider.available)
              .map((provider) => provider.id)
            void warmAllProviders(availableProviderIds)
          })
        }
      },
    )
    injectWebSocket(server as any)
  })
}
