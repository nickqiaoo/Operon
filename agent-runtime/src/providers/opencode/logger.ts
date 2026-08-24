import type { OpencodeLogger } from './types.js'
import { createRuntimeLogger, isRuntimeVerbose } from '../../logger.js'

const silentLogger: OpencodeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

export function getLogger(logger: OpencodeLogger | false | undefined, verbose?: boolean): OpencodeLogger {
  if (logger === false) return silentLogger
  if (logger) {
    if (verbose && !logger.debug) {
      return {
        ...logger,
        debug: (message) => logger.warn(`[DEBUG] ${message}`),
      }
    }
    return logger
  }
  // Always create a fresh logger so the verbose flag reflects current state
  return createRuntimeLogger('opencode-runtime', { verbose: verbose ?? isRuntimeVerbose() })
}

export function logUnsupportedCallOptions(
  logger: OpencodeLogger,
  options: {
    temperature?: number
    topP?: number
    topK?: number
    frequencyPenalty?: number
    presencePenalty?: number
    stopSequences?: string[]
    seed?: number
    maxTokens?: number
  },
): string[] {
  const warnings: string[] = []
  const entries = [
    ['temperature', options.temperature],
    ['topP', options.topP],
    ['topK', options.topK],
    ['frequencyPenalty', options.frequencyPenalty],
    ['presencePenalty', options.presencePenalty],
    ['stopSequences', options.stopSequences],
    ['seed', options.seed],
    ['maxTokens', options.maxTokens],
  ] as const

  for (const [name, value] of entries) {
    if (value === undefined) continue
    const warning = `Parameter '${name}' is not supported by OpenCode`
    logger.warn(warning)
    warnings.push(warning)
  }

  return warnings
}
