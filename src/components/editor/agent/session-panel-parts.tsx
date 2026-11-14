import { ChevronRight } from 'lucide-react'
import { useIntl } from 'react-intl'
import { cn } from '@/lib/utils'

/**
 * The Session panel's building blocks (cards, section headers, rows), shared by
 * AgentPanel and the sections that live in files of their own.
 */

// Every card in the column: the resting-card tier (border /60 + shadow-card).
export const CARD = 'rounded-xl border border-border/60 bg-popover shadow-card dark:border-border/35'

// Rows indent to their header's title, so nesting is visible before you read a word:
// 32px is the header's padding (12) + icon (14) + gap (6), so the two start on one line.
//
// No rule between rows. A divider per row plus a bordered header per section put a
// line every ~28px down a 400px column, which reads as a table of contents for a
// table of contents; the indent already says "these belong to that", and rows this
// tight do not need help staying apart. Lines are kept for the one boundary that
// carries meaning: between sections.
export const INDENT = 'pl-8 pr-3'
export const ROWS = INDENT
// An inspector should be dense — you scan it, you don't read it. 24px rows put the
// whole session on one screen, which is the difference between glancing and scrolling.
export const ROW = 'py-[3px] text-sm leading-5'

export function IconButton({
  onClick,
  label,
  disabled,
  children,
}: {
  onClick: () => void
  label: string
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-secondary-hover hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
  )
}

export function Dot({ className }: { className: string }) {
  return <span className={cn('inline-block h-1.5 w-1.5 rounded-full shrink-0', className)} />
}

/**
 * A status dot parked in the row's left indent, so rows with one line up with rows
 * without. `w-0` takes no width, but it is still a flex item, so the row's `gap-2`
 * would follow it and push the text 8px right of every dot-less row — `-mr-2` gives
 * that gap back. The dot itself is drawn to the left of where the text starts.
 */
export function RowDot({ className }: { className: string | null }) {
  return (
    <span className="relative -mr-2 w-0 shrink-0" aria-hidden>
      {className && <span className={cn('absolute -left-3.5 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full', className)} />}
    </span>
  )
}

/**
 * Section header badge. Same shape everywhere so the numbers mean the same
 * thing in every section: total on the right, with running / needs-attention
 * counts called out ahead of it when they're non-zero.
 */
export function Badge({ total, active, problems }: { total: number; active?: number; problems?: number }) {
  const intl = useIntl()
  // Two bare numbers side by side ("● 1  2") read as one ("12"); say what each is.
  const label = intl.formatMessage(
    {
      id: 'editor.session.badgeTitle',
      defaultMessage: '{active, plural, =0 {} other {# running · }}{problems, plural, =0 {} other {# need attention · }}{total} total',
    },
    { active: active ?? 0, problems: problems ?? 0, total },
  )
  return (
    <span title={label} aria-label={label} className="flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
      {!!active && (
        <span className="flex items-center gap-1 text-status-info">
          <Dot className="bg-status-info animate-pulse" />
          {active}
        </span>
      )}
      {!!problems && (
        <span className="flex items-center gap-1 text-status-error">
          <Dot className="bg-status-error" />
          {problems}
        </span>
      )}
      <span className="text-muted-foreground/45">{total}</span>
    </span>
  )
}

/**
 * Splits the panel in two: what is happening now, and what this session is able to do.
 *
 * They were one flat list of eight identical headers, which made a teammate blocked on an
 * approval look exactly as urgent as the count of installed plugins. The line is drawn by
 * lifetime: the top half changes while you watch, the bottom half changes when you go and
 * change it.
 */
export function GroupHeader({ label }: { label: React.ReactNode }) {
  return (
    // Uppercase + letterspacing is what separates this tier from the section labels
    // below it, which are sentence-case and darker. Two tiers of grey uppercase text
    // would read as one.
    // `px-3` is the cards' own padding, so the label, the overview title and every
    // section icon start on one line.
    <div className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/45">
      {label}
    </div>
  )
}

export function Section({
  icon: Icon,
  title,
  badge,
  expanded,
  onToggle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: React.ReactNode
  badge: React.ReactNode
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    // Each section is its own card; collapsed, the card is just its header.
    <section className={cn(CARD, 'shrink-0')}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        className={cn(
          // No fill, not even on hover: the card's edge already frames the header,
          // so a grey bar would be a second lid on the same box. The chevron is
          // what answers the pointer.
          'group/section flex h-9 cursor-pointer select-none items-center gap-1.5 rounded-xl px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <span className="flex-1 truncate text-[13px] font-semibold text-foreground/85">{title}</span>
        {badge}
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-[transform,color] group-hover/section:text-foreground',
            expanded && 'rotate-90',
          )}
        />
      </div>
      {expanded && <div className="pb-2">{children}</div>}
    </section>
  )
}
