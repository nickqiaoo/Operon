/** How long a new execution waits for one that was just stopped before moving on without it. */
export const STOPPED_EXECUTION_WAIT_MS = 5_000

/** False when `ms` elapsed first. `promise` is expected to resolve, never reject. */
export async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms) })
  try {
    return await Promise.race([promise.then(() => true as const), timeout])
  } finally {
    clearTimeout(timer)
  }
}
