export interface RuntimeLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

const isTruthy = (value: string | undefined): boolean => {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

export const isRuntimeVerbose = (): boolean =>
  isTruthy(process.env.OPERON_VERBOSE) || isTruthy(process.env.OPERON_RUNTIME_VERBOSE)

export function createRuntimeLogger(scope: string, options?: { verbose?: boolean }): RuntimeLogger {
  const verbose = options?.verbose ?? isRuntimeVerbose()
  const prefix = `[${scope}]`

  return {
    debug(message) {
      if (!verbose) return
      console.debug(`${prefix} ${message}`)
    },
    info(message) {
      console.info(`${prefix} ${message}`)
    },
    warn(message) {
      console.warn(`${prefix} ${message}`)
    },
    error(message) {
      console.error(`${prefix} ${message}`)
    },
  }
}
