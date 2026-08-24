'use client';

import { Gauge } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useIntl, type IntlShape } from 'react-intl';
import { MobileSheet } from '@/components/mobile/MobileSheet';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { ClaudeRateLimits, ClaudeRateLimitWindow } from '../utils/chatMetadata';

interface ClaudeRateLimitsButtonProps {
  rateLimits?: ClaudeRateLimits | null;
  className?: string;
}

// Fixed display order + labels for the plan quota windows the SDK reports.
const WINDOW_ORDER: Array<{ key: string; label: string }> = [
  { key: 'five_hour', label: '5-hour' },
  { key: 'seven_day', label: 'Weekly' },
  { key: 'seven_day_opus', label: 'Weekly · Opus' },
  { key: 'seven_day_sonnet', label: 'Weekly · Sonnet' },
  { key: 'seven_day_overage_included', label: 'Weekly · Overage' },
  { key: 'overage', label: 'Overage' },
];

type DisplayWindow = { key: string; label: string; window: ClaudeRateLimitWindow; used: number };

const normalizePercent = (value: number): number => {
  const normalized = value < 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, normalized));
};

const formatPercent = (value: number): string => `${value.toFixed(value >= 10 ? 0 : 1)}%`;

const formatResetTime = (value: number | undefined, intl: IntlShape): string => {
  if (!value) return intl.formatMessage({ id: 'editor.claude.unknown', defaultMessage: 'Unknown' });
  // The SDK may hand back epoch seconds or milliseconds — normalize to ms.
  const timestamp = value > 1_000_000_000_000 ? value : value * 1000;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
};

// Per-model weekly windows (e.g. Fable) come through with the server-supplied
// model name embedded in the key, since the set of buckets is dynamic.
const MODEL_SCOPED_PREFIX = 'model_scoped:';

const collectWindows = (rateLimits?: ClaudeRateLimits | null): DisplayWindow[] => {
  if (!rateLimits?.windows) return [];
  const result: DisplayWindow[] = [];
  for (const { key, label } of WINDOW_ORDER) {
    const window = rateLimits.windows[key];
    if (!window || typeof window.utilization !== 'number') continue;
    result.push({ key, label, window, used: normalizePercent(window.utilization) });
  }
  for (const key of Object.keys(rateLimits.windows).sort()) {
    if (!key.startsWith(MODEL_SCOPED_PREFIX)) continue;
    const window = rateLimits.windows[key];
    if (!window || typeof window.utilization !== 'number') continue;
    result.push({
      key,
      label: `Weekly · ${key.slice(MODEL_SCOPED_PREFIX.length)}`,
      window,
      used: normalizePercent(window.utilization),
    });
  }
  return result;
};

// The 5-hour window drives the trigger badge — it is the quota that actually
// gates the next few turns. Fall back to the most-consumed window only when the
// plan reports no 5-hour bucket at all.
const bindingWindow = (windows: DisplayWindow[]): DisplayWindow | null =>
  windows.find((w) => w.key === 'five_hour') ??
  windows.reduce<DisplayWindow | null>(
    (max, w) => (max === null || w.used > max.used ? w : max),
    null,
  );

// Color by how much is consumed: comfortable → muted, running low → amber,
// exhausted → red.
const usedTone = (used: number): string => {
  if (used >= 100) return 'text-destructive';
  if (used >= 85) return 'text-amber-600 dark:text-amber-500';
  return 'text-muted-foreground';
};

const renderWindowBlock = (item: DisplayWindow, intl: IntlShape) => {
  const high = item.used >= 85;
  return (
    <div className="space-y-2 rounded-xl bg-muted/40 px-3 py-2.5" key={item.key}>
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="text-muted-foreground">{item.label}</span>
        <span className={cn('font-mono', high ? usedTone(item.used) : 'text-foreground')}>
          {intl.formatMessage(
            { id: 'editor.claude.percentUsed', defaultMessage: '{percent} used' },
            { percent: formatPercent(item.used) },
          )}
        </span>
      </div>
      <Progress className="h-1.5 bg-muted/70" value={item.used} />
      <div className="flex items-center justify-end text-[11px] text-muted-foreground">
        <span>
          {intl.formatMessage(
            { id: 'editor.claude.resets', defaultMessage: 'Resets {time}' },
            { time: formatResetTime(item.window.resetsAt, intl) },
          )}
        </span>
      </div>
    </div>
  );
};

/** Shared popover/sheet body — the ordered list of quota windows. */
function ClaudeRateLimitsContent({
  windows,
  subscriptionType,
}: {
  windows: DisplayWindow[];
  subscriptionType?: string;
}) {
  const intl = useIntl();
  return (
    <div className="space-y-2.5">
      {subscriptionType ? (
        <p className="px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
          {intl.formatMessage(
            { id: 'editor.claude.plan', defaultMessage: '{plan} plan' },
            { plan: subscriptionType },
          )}
        </p>
      ) : null}
      {windows.length > 0 ? (
        windows.map((item) => renderWindowBlock(item, intl))
      ) : (
        <div className="rounded-2xl bg-muted/35 px-3 py-3 text-sm text-muted-foreground">
          {intl.formatMessage({ id: 'editor.claude.noData', defaultMessage: 'No usage data yet.' })}
        </div>
      )}
    </div>
  );
}

function TriggerContent({ windows }: { windows: DisplayWindow[] }) {
  const binding = bindingWindow(windows);
  return (
    <>
      {binding ? <span className="font-mono text-xs">{formatPercent(binding.used)}</span> : null}
      <Gauge className={cn('size-3.5', binding ? usedTone(binding.used) : undefined)} />
    </>
  );
}

const triggerClassName =
  'h-8 gap-2 rounded-full border-border/60 bg-background/70 px-3 text-xs shadow-none hover:bg-muted/40';

/** Desktop: quota summary in a hover-less popover on click. */
export function ClaudeRateLimitsButton({ rateLimits, className }: ClaudeRateLimitsButtonProps) {
  const intl = useIntl();
  const windows = useMemo(() => collectWindows(rateLimits), [rateLimits]);

  if (windows.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label={intl.formatMessage({ id: 'editor.claude.aria', defaultMessage: 'Open subscription usage details' })}
          className={cn(triggerClassName, className)}
          size="sm"
          type="button"
          variant="outline"
        >
          <TriggerContent windows={windows} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[340px] rounded-2xl border border-border/40 bg-background/95 p-3 shadow-float backdrop-blur"
        side="top"
      >
        <ClaudeRateLimitsContent windows={windows} subscriptionType={rateLimits?.subscriptionType} />
      </PopoverContent>
    </Popover>
  );
}

/** Mobile: same trigger opens a bottom sheet with the full breakdown on tap. */
export function MobileClaudeRateLimits({ rateLimits, className }: ClaudeRateLimitsButtonProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const windows = useMemo(() => collectWindows(rateLimits), [rateLimits]);

  if (windows.length === 0) return null;

  return (
    <>
      <Button
        aria-label={intl.formatMessage({ id: 'editor.claude.aria', defaultMessage: 'Open subscription usage details' })}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(triggerClassName, className)}
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        <TriggerContent windows={windows} />
      </Button>
      <MobileSheet
        open={open}
        onClose={() => setOpen(false)}
        title={intl.formatMessage({ id: 'editor.claude.title', defaultMessage: 'Subscription usage' })}
      >
        <ClaudeRateLimitsContent windows={windows} subscriptionType={rateLimits?.subscriptionType} />
      </MobileSheet>
    </>
  );
}
