import process from 'node:process'
import type { MemoryMaintenanceStorageAdapter } from '../../storage/interface.js'
import type { MemoryMaintenanceTrigger } from '../../types/memory-maintenance.js'
import { createMaintenanceLogger } from './logger.js'
import { withRunLog } from './run-log.js'
import { runExtractor } from './extractor.js'

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
  memoriesMerged: number
  tokensInput: number
  tokensOutput: number
  error?: string
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
    // Cross-page merges now happen at write time, not in a consolidation pass —
    // this stat stays for the run-record schema but is always 0.
    const memoriesMerged = 0
    let tokensInput = 0
    let tokensOutput = 0
    const errors: string[] = []

    try {
      const cwd = process.cwd()

      if (config.layer1Enabled) {
        const extractStats = await runExtractor(storage, {
          providerId,
          modelId: config.modelId,
          cwd,
          maxSessionsPerRun: config.maxSessionsPerRun,
          signal: options.signal,
        })
        sessionsProcessed += extractStats.sessionsProcessed
        chunksProcessed += extractStats.chunksProcessed
        memoriesWritten += extractStats.memoriesWritten
        tokensInput += extractStats.tokensInput
        tokensOutput += extractStats.tokensOutput
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
        memoriesMerged,
        tokensInput,
        tokensOutput,
        status,
        error: errors.length > 0 ? errors.slice(0, 5).join(' | ') : undefined,
      })

      logger.info(
        `done run=${run.id} status=${status} sessions=${sessionsProcessed} chunks=${chunksProcessed} written=${memoriesWritten} merged=${memoriesMerged} tokens=${tokensInput}/${tokensOutput}`
      )

      return {
        runId: run.id,
        status,
        sessionsProcessed,
        chunksProcessed,
        memoriesWritten,
        memoriesMerged,
        tokensInput,
        tokensOutput,
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
        memoriesMerged,
        tokensInput,
        tokensOutput,
        status: 'error',
        error: msg,
      })
      return {
        runId: run.id,
        status: 'error',
        sessionsProcessed,
        chunksProcessed,
        memoriesWritten,
        memoriesMerged,
        tokensInput,
        tokensOutput,
        error: msg,
      }
    }
  })
}
