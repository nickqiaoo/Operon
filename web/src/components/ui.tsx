import type { ReactNode } from 'react'
import { cn } from '../lib/styles'

/**
 * Shared building blocks for the landing page.
 *
 * The page borrows the app's own visual language instead of a marketing skin:
 * structure comes from surface greys and hairline borders, not glows; one brand
 * colour, not a colour per section; short shadows only on things that float.
 * Every section is assembled from these so the rhythm stays the same top to
 * bottom.
 */

/** A page band. `tone="sidebar"` shifts it one grey step for alternation. */
export function Section({
  id,
  tone = 'background',
  children,
  className,
  width = 'default',
}: {
  id?: string
  tone?: 'background' | 'sidebar'
  children: ReactNode
  className?: string
  width?: 'default' | 'narrow'
}) {
  return (
    <section
      id={id}
      className={cn(
        'relative py-16 md:py-24',
        tone === 'sidebar' && 'border-y border-border/40 bg-sidebar',
        className,
      )}
    >
      <div className={cn('mx-auto w-full px-4 md:px-8', width === 'narrow' ? 'max-w-3xl' : 'max-w-6xl')}>
        {children}
      </div>
    </section>
  )
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="mb-3 text-[13px] font-medium text-brand">{children}</p>
}

export function Title({ children, center = false }: { children: ReactNode; center?: boolean }) {
  return (
    <h2
      className={cn(
        'font-display text-[30px] leading-[1.12] font-semibold tracking-[-0.025em] text-foreground md:text-[42px]',
        center && 'text-center',
      )}
    >
      {children}
    </h2>
  )
}

/** Second half of a title, one step quieter. */
export function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>
}

export function Lead({ children, center = false }: { children: ReactNode; center?: boolean }) {
  return (
    <p
      className={cn(
        'mt-4 max-w-2xl text-[16px] leading-[1.7] text-muted-foreground md:text-[17px]',
        center && 'mx-auto text-center',
      )}
    >
      {children}
    </p>
  )
}

export interface Feature {
  title: string
  desc: string
}

export function FeatureList({ items, columns = 1 }: { items: Feature[]; columns?: 1 | 2 | 3 }) {
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-x-8 gap-y-5',
        columns === 2 && 'sm:grid-cols-2',
        columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3',
      )}
    >
      {items.map((item) => (
        <div key={item.title} className="border-l border-border/60 pl-4">
          <div className="text-[14.5px] font-medium text-foreground">{item.title}</div>
          <div className="mt-1 text-[14px] leading-[1.6] text-muted-foreground">{item.desc}</div>
        </div>
      ))}
    </div>
  )
}

/** Copy beside a visual; stacks on phones with the copy first. */
export function Split({
  copy,
  visual,
  reverse = false,
}: {
  copy: ReactNode
  visual: ReactNode
  reverse?: boolean
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-1 items-center gap-10 lg:gap-16',
        reverse ? 'lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]' : 'lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]',
      )}
    >
      <div className={cn('min-w-0', reverse && 'lg:order-2')}>{copy}</div>
      <div className={cn('min-w-0', reverse && 'lg:order-1')}>{visual}</div>
    </div>
  )
}

/**
 * Frame for an illustrated app window. The mock inside is drawn with the same
 * tokens as the app, so it switches theme with the page.
 */
export function Window({
  title,
  children,
  className,
  toolbar,
}: {
  title?: string
  children: ReactNode
  className?: string
  toolbar?: ReactNode
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-border/60 bg-background shadow-float',
        className,
      )}
      aria-hidden
    >
      <div className="flex h-9 items-center gap-3 border-b border-border/50 bg-sidebar px-3.5">
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-border" />
          <span className="h-2.5 w-2.5 rounded-full bg-border" />
          <span className="h-2.5 w-2.5 rounded-full bg-border" />
        </div>
        {title && <div className="min-w-0 flex-1 truncate text-center text-[12px] text-muted-foreground">{title}</div>}
        {toolbar ?? (title && <div className="w-[42px]" />)}
      </div>
      {children}
    </div>
  )
}

/**
 * A real product screenshot with a light and a dark capture; the browser picks
 * the one matching the visitor's system theme, like the rest of the page.
 * Captured from a demo profile (fictional repos), never from a real workspace.
 */
export function ThemedShot({
  light,
  dark,
  alt,
  aspect,
  className,
  eager = false,
}: {
  light: string
  dark: string
  alt: string
  /** Above the fold: load immediately instead of when scrolled near. */
  eager?: boolean
  /** Crop to this ratio, anchored at the top of the capture. */
  aspect?: string
  className?: string
}) {
  return (
    <div
      className={cn('overflow-hidden rounded-xl border border-border/60 bg-background shadow-float', className)}
      style={{ aspectRatio: aspect }}
    >
      <picture>
        <source srcSet={dark} media="(prefers-color-scheme: dark)" />
        <img
          src={light}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          fetchPriority={eager ? 'high' : 'auto'}
          decoding="async"
          className="block h-full w-full object-cover object-top" />
      </picture>
    </div>
  )
}

/* ===== Small pieces the mocks share ===== */

const AGENT_COLORS: Record<string, string> = {
  'Claude Code': '#d97757',
  Codex: '#10a37f',
  OpenCode: '#64748b',
  Cursor: '#3b3b46',
  Operon: '#6358dc',
  Antigravity: '#4285f4',
  Grok: '#52525b',
  Kimi: '#1f7a8c',
  Copilot: '#2f81f7',
}

/** Coloured initial avatar, the way agents appear on the board and in the assistant. */
export function AgentAvatar({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.48),
        background: AGENT_COLORS[name] ?? '#6358dc',
      }}
    >
      {name.charAt(0)}
    </span>
  )
}

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-border/50 bg-background px-2 py-0.5 text-[11px] text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  )
}

/** Monochrome brand mark drawn through a CSS mask so it follows the text colour. */
export function MaskIcon({ src, size = 18, className }: { src: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block shrink-0 bg-current', className)}
      style={{
        width: size,
        height: size,
        WebkitMaskImage: `url("${src}")`,
        maskImage: `url("${src}")`,
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
      }}
    />
  )
}
