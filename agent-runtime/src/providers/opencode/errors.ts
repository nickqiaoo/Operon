export function extractErrorMessage(error: unknown): string {
  if (!error) return 'Unknown error'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>
    if (typeof record.message === 'string') return record.message
    if (typeof record.error === 'string') return record.error
  }
  return String(error)
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  if (record.name === 'AbortError' || record.name === 'MessageAbortedError') return true
  return typeof record.code === 'string' && record.code.toUpperCase() === 'ABORT_ERR'
}

export function createTimeoutError(timeoutMs: number, operation?: string): Error {
  const suffix = operation ? ` during ${operation}` : ''
  return new Error(`OpenCode request timed out after ${timeoutMs}ms${suffix}`)
}
