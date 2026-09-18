import { RefreshCw } from 'lucide-react';
import { useIntl } from 'react-intl';
import { ProviderIcon } from '@/components/editor/components/ModelSelectorPanel';
import { usageBarTone } from '@/components/editor/components/rate-limit-tone';
import { cn } from '@/lib/utils';
import { useAccountUsage, type ProviderUsage } from './useAccountUsage';

const formatPercent = (value: number): string => `${Math.round(value)}%`;

/**
 * The bar tracks the short window, and the weekly one is left to its number.
 *
 * It used to fill from whichever window was further along, on the grounds that
 * this is the one that stops the next turn. True, but it made the bar unreadable:
 * a weekly budget sits high for days at a time, so the bar stayed pinned and red
 * while the 5-hour number beside it read 18% — the two disagreed on screen and
 * the bar was the one that looked wrong. The short window is also the one that
 * actually moves within a session, which is what a meter is for.
 */
const barPercent = (usage: ProviderUsage): number => usage.shortPercent ?? usage.longPercent ?? 0;

function ProviderUsageItem({ usage }: { usage: ProviderUsage }) {
  const intl = useIntl();
  const fill = barPercent(usage);

  // Numbers stay quiet at every level — the bar beside them is already saying
  // how close the window is, and coloring both made one provider's spent budget
  // the loudest thing in the title bar.
  // The `formatMessage` calls stay literal — formatjs extracts statically, and
  // an id passed through a variable is silently dropped from the catalogue.
  const windowPart = (percent: number, unit: string) => (
    <>
      <span>{formatPercent(percent)}</span>
      <span className="text-muted-foreground">{unit}</span>
    </>
  );

  const short =
    usage.shortPercent === undefined
      ? null
      : windowPart(
          usage.shortPercent,
          intl.formatMessage({ id: 'usageBar.shortUnit', defaultMessage: '5h' }),
        );
  const long =
    usage.longPercent === undefined
      ? null
      : windowPart(
          usage.longPercent,
          intl.formatMessage({ id: 'usageBar.longUnit', defaultMessage: 'wk' }),
        );

  // The bar keeps its own width; only the labels give way, so the two providers
  // stay aligned with each other at every width.
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <ProviderIcon id={usage.providerId} size={12} />
      <div className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-[width]', usageBarTone(fill))}
          style={{ width: `${Math.max(fill, 2)}%` }}
        />
      </div>
      <span className="flex items-center gap-1 whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground @max-[700px]/topbar:hidden">
        {short}
        {short && long ? (
          <span className="text-muted-foreground/40 @max-[880px]/topbar:hidden">·</span>
        ) : null}
        {long ? (
          <span className="flex items-center gap-1 @max-[880px]/topbar:hidden">{long}</span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Account quota for every signed-in provider, in the window's title bar.
 *
 * Lives here rather than beside the composer because it is not a property of
 * the open conversation: it answers "how much have I got left today", which
 * holds whichever chat — or no chat — is in front.
 *
 * Must be rendered as a real child of the title bar's drag region. `no-drag`
 * is only honored by macOS for actual children of the dragging element; a
 * floating wrapper would let clicks fall through to the drag region and the
 * refresh button would quietly stop working.
 */
export function AccountUsageBar({ className }: { className?: string }) {
  const intl = useIntl();
  const { providers, isRefreshing, refresh } = useAccountUsage();

  if (providers.length === 0) return null;

  // Degrades in stages as the title bar narrows, rather than pushing the
  // breadcrumb out of the row: first the weekly window goes, then the labels
  // (leaving icon + bar, which still says how much is left at a glance), and
  // below that the bar is not worth the space it takes from the crumb.
  return (
    <div
      className={cn(
        'no-drag flex items-center gap-3 @max-[540px]/topbar:hidden',
        className,
      )}
    >
      {providers.map((usage) => (
        <ProviderUsageItem key={usage.providerId} usage={usage} />
      ))}
      <button
        type="button"
        onClick={refresh}
        className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground"
        title={intl.formatMessage({ id: 'usageBar.refresh', defaultMessage: 'Refresh usage' })}
      >
        <RefreshCw className={cn('h-3 w-3', isRefreshing && 'animate-spin')} />
      </button>
    </div>
  );
}
