import type { LanguageModelUsage } from 'ai'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function add(a: unknown, b: unknown): unknown {
  if (typeof a === 'number' || typeof b === 'number') {
    return (typeof a === 'number' ? a : 0) + (typeof b === 'number' ? b : 0)
  }
  if (!isRecord(a) || !isRecord(b)) return b ?? a
  const sum: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    // `raw` is one provider response, not a counter.
    sum[key] = key === 'raw' ? b[key] ?? a[key] : add(a[key], b[key])
  }
  return sum
}

/** Combined usage of several native turns reported as one execution. */
export function addUsage(a: LanguageModelUsage, b: LanguageModelUsage): LanguageModelUsage {
  return add(a, b) as LanguageModelUsage
}
