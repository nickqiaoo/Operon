import type { ClaudeRateLimits, CodexRateLimits } from './chatMetadata'

export function quotaSendTime(model: string, codex?: CodexRateLimits | null, claude?: ClaudeRateLimits | null, now = Date.now()) {
  const name = model.toLowerCase()
  const windows: { blocked: boolean; reset?: number | null }[] = []
  if (codex) {
    const buckets = Object.entries(codex.rateLimitsByLimitId ?? {})
    const scoped = buckets.find(([key]) => key !== 'codex' && name.includes(key.toLowerCase().replaceAll('_', '-')))
    const snapshot = scoped?.[1] ?? codex.rateLimitsByLimitId?.codex ?? codex.rateLimits
    for (const w of [snapshot?.primary, snapshot?.secondary]) {
      if (w) windows.push({ blocked: w.usedPercent >= 100, reset: w.resetsAt })
    }
  }
  for (const [key, w] of Object.entries(claude?.windows ?? {})) {
    const scope = key.startsWith('model_scoped:') ? key.slice(13) : key.startsWith('seven_day_') ?
      (key === 'seven_day_overage_included' ? 'fable' : key.slice(10)) : null
    if (scope && !name.includes(scope.toLowerCase())) continue
    if (key === 'overage') continue
    windows.push({ blocked: w.status === 'rejected' || (w.utilization ?? 0) >= 100, reset: w.resetsAt })
  }
  const blocked = windows.filter(w => w.blocked)
  const times = (blocked.length ? blocked : windows).map(w => {
    const t = w.reset ?? 0
    return t < 1e12 ? t * 1000 : t
  })
  if (blocked.length && times.some(t => t <= 0 || !Number.isFinite(t))) return null
  const future = times.filter(t => Number.isFinite(t) && t + 30_000 > now)
  return future.length ? (blocked.length ? Math.max(...future) : Math.min(...future)) + 30_000 : null
}
