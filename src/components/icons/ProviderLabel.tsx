import type { ReactNode } from 'react'
import { providerLogoSrc } from '@/lib/provider-logos'
import { cn } from '@/lib/utils'

export function ProviderIcon({ id, size = 14 }: { id: string; size?: number }) {
  const src = providerLogoSrc(id);
  if (!src) return <span className="inline-block rounded bg-muted/60 flex-shrink-0" style={{ width: size, height: size }} />;
  return (
    <img src={src} alt="" width={size} height={size}
      className="dark:invert flex-shrink-0"
      style={{ width: size, height: size, objectFit: 'contain' }}
    />
  );
}


/** A provider's existing logo beside its name or model, wherever an agent is credited. */
export function ProviderLabel({ id, children, className, size = 13 }: {
  id: string
  children?: ReactNode
  className?: string
  size?: number
}) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 align-middle', className)}>
      <ProviderIcon id={id} size={size} />
      <span className="min-w-0 truncate">{children ?? id}</span>
    </span>
  )
}
