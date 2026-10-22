import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ProviderLabel } from '@/components/icons/ProviderLabel'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { SpecSeat } from '@shared/spec'

/** Radix Select reserves the empty value; these stand for "automatic" and "the agent's own default model". */
const AUTO = '__auto__'
const DEFAULT_MODEL = '__default__'

interface ModelOption {
  modelId: string
  name: string
}

/**
 * Which agent plays a seat, and on which model: a provider, then that provider's
 * models (its own default first). `autoLabel` offers "automatic" (null) as well —
 * Settings uses it; switching a seat on a spec always names an agent.
 */
export function SeatPicker({
  value,
  providers,
  onChange,
  autoLabel,
  className,
}: {
  value: SpecSeat | null
  /** Providers that can be picked. */
  providers: readonly string[]
  onChange: (seat: SpecSeat | null) => void
  autoLabel?: string
  className?: string
}) {
  const intl = useIntl()
  const providerId = value?.providerId
  const [models, setModels] = useState<ModelOption[] | null>(null)

  useEffect(() => {
    if (!providerId) return
    let cancelled = false
    setModels(null)
    api
      .getProviderModels(providerId)
      .then((result: { models?: ModelOption[] }) => {
        if (!cancelled) setModels((result?.models ?? []).map((m) => ({ modelId: m.modelId, name: m.name })))
      })
      .catch(() => {
        if (!cancelled) setModels([])
      })
    return () => {
      cancelled = true
    }
  }, [providerId])

  const modelId = value?.modelId ?? ''
  // A model that is no longer offered still shows, so the choice stays visible.
  const options = models && modelId && !models.some((m) => m.modelId === modelId) ? [{ modelId, name: modelId }, ...models] : (models ?? [])
  // A provider no longer usable here still shows for the same reason.
  const providerOptions = providerId && !providers.includes(providerId) ? [providerId, ...providers] : providers

  return (
    <div className={cn('flex min-w-0 flex-wrap gap-2', className)}>
      <Select
        value={providerId ?? AUTO}
        onValueChange={(next) => onChange(next === AUTO ? null : { providerId: next })}
      >
        <SelectTrigger size="sm" className="h-8 w-[150px] shrink-0 border-border/50 bg-background/80 text-xs">
          <SelectValue placeholder={intl.formatMessage({ id: 'spec.seat.pickAgent', defaultMessage: 'Pick an agent' })} />
        </SelectTrigger>
        <SelectContent>
          {autoLabel && (
            <SelectItem value={AUTO} className="text-xs">
              {autoLabel}
            </SelectItem>
          )}
          {providerOptions.map((p) => (
            <SelectItem key={p} value={p} className="text-xs">
              <ProviderLabel id={p} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value && (
        <Select
          value={modelId || DEFAULT_MODEL}
          onValueChange={(next) => onChange(next === DEFAULT_MODEL ? { providerId: value.providerId } : { providerId: value.providerId, modelId: next })}
        >
          <SelectTrigger size="sm" className="h-8 min-w-0 flex-1 basis-40 border-border/50 bg-background/80 text-xs">
            <SelectValue
              placeholder={
                models === null
                  ? intl.formatMessage({ id: 'spec.seat.loadingModels', defaultMessage: 'Loading models…' })
                  : intl.formatMessage({ id: 'spec.seat.defaultModel', defaultMessage: 'Agent default' })
              }
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_MODEL} className="text-xs">
              {intl.formatMessage({ id: 'spec.seat.defaultModel', defaultMessage: 'Agent default' })}
            </SelectItem>
            {options.map((m) => (
              <SelectItem key={m.modelId} value={m.modelId} className="text-xs">
                {m.name === m.modelId ? m.modelId : `${m.name} · ${m.modelId}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}

/** `codex`, or `opencode · vendor/model`. */
export function seatName(seat: SpecSeat | null | undefined): string {
  if (!seat) return '—'
  return seat.modelId ? `${seat.providerId} · ${seat.modelId}` : seat.providerId
}
