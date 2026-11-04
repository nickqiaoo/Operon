import process from 'node:process'
import type { MemoryMaintenanceStorageAdapter } from '../../storage/interface.js'
import type { MemoryMaintenanceTrigger } from '../../types/memory-maintenance.js'
import { createMaintenanceLogger } from './logger.js'
import { withRunLog } from './run-log.js'
import { runExtractor } from './extractor.js'
import { maintenanceWorkdir } from './extraction-source.js'
import { resolveMcpServersForSession } from '../mcp-config.js'

const logger = createMaintenanceLogger('memory-maintenance')

export interface MaintenanceRunOptions {
  trigger?: MemoryMaintenanceTrigger
  signal?: AbortSignal
}

export interface MaintenanceRunOutcome {
  runId: number
  status: 'success' | 'error' | 'aborted'
  sessionsProcessed: number
  chunksProcessed: number
  memoriesWritten: number
  error?: string
}

/**
 * One run at a time, whoever triggers it (schedule or the Settings button).
 * The extractor's write attribution relies on it: the memory MCP route reads
 * the conversation being extracted from a single process-wide slot.
 */
let activeRun = false

export function isMemoryMaintenanceRunning(): boolean {
  return activeRun
}

/**
 * Development aid for tuning the extraction prompt: with
 * `OPERON_MEMORY_EVAL_CHATS=1136,1143,…` set on the server, a manual run
 * ("Run now") extracts exactly those chats from the start and moves no
 * watermark, so a fixed set of conversations can be re-run in a minute instead
 * of waiting on a full pass. Scheduled runs ignore it.
 */
function evalChatIdsFromEnv(): number[] | undefined {
  const raw = process.env.OPERON_MEMORY_EVAL_CHATS?.trim()
  if (!raw) return undefined
  const ids = raw
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
  return ids.length > 0 ? ids : undefined
}

/**
 * Execute one memory-maintenance pass: Layer 1 (extract). Cross-page dedup and
 * truth reconciliation now happen at write time inside `memory_upsert` (see
 * memory/operations.ts), so there is no longer a separate consolidation layer.
 * Results are recorded to `memory_maintenance_runs` for audit.
 */
export async function runMemoryMaintenance(
  storage: MemoryMaintenanceStorageAdapter,
  options: MaintenanceRunOptions = {}
): Promise<MaintenanceRunOutcome> {
  if (activeRun) throw new Error('A maintenance run is already in progress')
  activeRun = true
  try {
    return await runOnce(storage, options)
  } finally {
    activeRun = false
  }
}

async function runOnce(
  storage: MemoryMaintenanceStorageAdapter,
  options: MaintenanceRunOptions
): Promise<MaintenanceRunOutcome> {
  const config = storage.getMemoryMaintenanceConfig()
  if (!config.enabled) {
    throw new Error('Memory maintenance is disabled')
  }
  if (!config.providerId) {
    throw new Error('Memory maintenance: providerId is not configured')
  }

  const trigger = options.trigger ?? 'scheduled'
  const providerId = config.providerId
  const run = storage.createMemoryMaintenanceRun({
    startedAt: Date.now(),
    layer: 'full',
    providerId,
    modelId: config.modelId,
    trigger,
  })

  return withRunLog(run.id, async () => {
    logger.info(
      `start run=${run.id} provider=${providerId} model=${config.modelId ?? 'default'} trigger=${trigger}`
    )
    logger.info(
      `config layer1=${config.layer1Enabled} maxSessions=${config.maxSessionsPerRun}`
    )

    let sessionsProcessed = 0
    let chunksProcessed = 0
    let memoriesWritten = 0
    const errors: string[] = []

    try {
      const cwd = maintenanceWorkdir()

      // The extractor only acts through the memory MCP server. A provider that
      // gets none (no MCP support, or memory switched off) would otherwise read
      // every chat, find no tools, and finish "successfully" with 0 writes.
      if (config.layer1Enabled && !resolveMcpServersForSession(providerId)?.memory) {
        throw new Error(
          `Provider "${providerId}" gets no memory MCP server (it is not wired for MCP, or memory/embedding is disabled), so it cannot write memories`
        )
      }

      if (config.layer1Enabled) {
        const extractStats = await runExtractor(storage, {
          providerId,
          modelId: config.modelId,
          cwd,
          maxSessionsPerRun: config.maxSessionsPerRun,
          // Manual runs only: a variable left set must never turn the daily
          // run into a re-run of the fixed set that moves no watermark.
          evalChatIds: trigger === 'manual' ? evalChatIdsFromEnv() : undefined,
          signal: options.signal,
        })
        sessionsProcessed += extractStats.sessionsProcessed
        chunksProcessed += extractStats.chunksProcessed
        memoriesWritten += extractStats.memoriesWritten
        errors.push(...extractStats.errors)
      } else {
        logger.info('layer1 (extract) disabled — skipping')
      }

      const status: MaintenanceRunOutcome['status'] = options.signal?.aborted
        ? 'aborted'
        : errors.length > 0
          ? 'error'
          : 'success'

      storage.updateMemoryMaintenanceRun(run.id, {
        finishedAt: Date.now(),
        sessionsProcessed,
        chunksProcessed,
        memoriesWritten,
        status,
        error: errors.length > 0 ? errors.slice(0, 5).join(' | ') : undefined,
      })

      logger.info(
        `done run=${run.id} status=${status} sessions=${sessionsProcessed} chunks=${chunksProcessed} written=${memoriesWritten}`
      )

      return {
        runId: run.id,
        status,
        sessionsProcessed,
        chunksProcessed,
        memoriesWritten,
        error: errors.length > 0 ? errors.slice(0, 5).join(' | ') : undefined,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(`run=${run.id} fatal: ${msg}`)
      storage.updateMemoryMaintenanceRun(run.id, {
        finishedAt: Date.now(),
        sessionsProcessed,
        chunksProcessed,
        memoriesWritten,
        status: 'error',
        error: msg,
      })
      return {
        runId: run.id,
        status: 'error',
        sessionsProcessed,
        chunksProcessed,
        memoriesWritten,
        error: msg,
      }
    }
  })
}
