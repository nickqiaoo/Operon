import { createRuntimeLogger, type RuntimeLogger } from '@operon/agent-runtime'
import { writeRunLog } from './run-log.js'

/**
 * Logger for memory-maintenance modules. Writes to console via the shared
 * runtime logger and — when invoked inside `withRunLog()` — also appends to
 * the active run's log file so users can inspect each run from the UI.
 */
export function createMaintenanceLogger(scope: string): RuntimeLogger {
  const base = createRuntimeLogger(scope)
  return {
    debug(message) {
      base.debug(message)
      writeRunLog('debug', scope, message)
    },
    info(message) {
      base.info(message)
      writeRunLog('info', scope, message)
    },
    warn(message) {
      base.warn(message)
      writeRunLog('warn', scope, message)
    },
    error(message) {
      base.error(message)
      writeRunLog('error', scope, message)
    },
  }
}
