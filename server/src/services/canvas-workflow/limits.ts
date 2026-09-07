/** Default wall-clock budget for deterministic nodes (shell / http / code). */
export const DEFAULT_NODE_TIMEOUT_MS = 30_000

/** Longest output a node may publish; anything beyond is cut with a marker. */
export const MAX_NODE_OUTPUT_CHARS = 256 * 1024

export const OUTPUT_TRUNCATED_MARKER = '\n…[output truncated]'

export function truncateOutput(output: string, max: number = MAX_NODE_OUTPUT_CHARS): string {
  if (output.length <= max) return output
  return output.slice(0, max) + OUTPUT_TRUNCATED_MARKER
}

export class NodeTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`)
    this.name = 'NodeTimeoutError'
  }
}

/**
 * Race `run` against a timer. The controller is aborted on timeout so the
 * executor can stop the underlying process / request instead of leaking it.
 */
export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  label: string
): Promise<T> {
  const controller = new AbortController()
  if (timeoutMs === undefined) return run(controller.signal)

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new NodeTimeoutError(label, timeoutMs))
    }, timeoutMs)
  })
  try {
    return await Promise.race([run(controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
