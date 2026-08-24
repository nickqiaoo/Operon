'use client';

import { Gauge } from 'lucide-react';
import { useMemo } from 'react';
import { useIntl, type IntlShape } from 'react-intl';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { ContextUsageMetadata, RateLimitSnapshot } from '../utils/chatMetadata';

type CodexAccountState = NonNullable<ContextUsageMetadata['codexAccount']>;
type CodexRateLimitsState = NonNullable<ContextUsageMetadata['codexRateLimits']>;

interface CodexRateLimitsButtonProps {
  account?: CodexAccountState;
  rateLimits?: CodexRateLimitsState;
  className?: string;
}

const formatPercent = (value: number): string => {
  const normalized = value < 1 ? value * 100 : value;
  return `${normalized.toFixed(normalized >= 10 ? 0 : 1)}%`;
};

const normalizePercentValue = (value: number): number => {
  const normalized = value < 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, normalized));
};

const formatWindowLabel = (value: number | null | undefined, intl: IntlShape): string => {
  if (!value) return intl.formatMessage({ id: 'editor.codex.window', defaultMessage: 'Window' });
  if (value === 10080) return intl.formatMessage({ id: 'editor.codex.weekly', defaultMessage: 'Weekly' });
  if (value % 1440 === 0) {
    const days = value / 1440;
    return days === 7
      ? intl.formatMessage({ id: 'editor.codex.weekly', defaultMessage: 'Weekly' })
      : intl.formatMessage({ id: 'editor.codex.days', defaultMessage: '{count} days' }, { count: days });
  }
  if (value % 60 === 0) {
    const hours = value / 60;
    return intl.formatMessage({ id: 'editor.codex.hours', defaultMessage: '{count} hours' }, { count: hours });
  }
  return intl.formatMessage({ id: 'editor.codex.minutes', defaultMessage: '{count} min' }, { count: value });
};

const formatResetTime = (value: number | null | undefined, intl: IntlShape): string => {
  if (!value) return intl.formatMessage({ id: 'editor.codex.unknown', defaultMessage: 'Unknown' });
  const timestamp = value > 1_000_000_000_000 ? value : value * 1000;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
};

const getSnapshotKey = (snapshot: RateLimitSnapshot): string =>
  snapshot.limitId ?? snapshot.limitName ?? 'default';

const getSnapshotLabel = (snapshot: RateLimitSnapshot): string =>
  snapshot.limitName ?? snapshot.limitId ?? 'Default';

const collectSnapshots = (rateLimits?: CodexRateLimitsState): RateLimitSnapshot[] => {
  if (!rateLimits) return [];

  const allSnapshots = [
    ...(rateLimits.rateLimits ? [rateLimits.rateLimits] : []),
    ...Object.values(rateLimits.rateLimitsByLimitId ?? {}),
  ];

  const uniqueSnapshots = new Map<string, RateLimitSnapshot>();
  for (const snapshot of allSnapshots) {
    uniqueSnapshots.set(getSnapshotKey(snapshot), snapshot);
  }

  return [...uniqueSnapshots.values()].sort((left, right) =>
    getSnapshotLabel(left).localeCompare(getSnapshotLabel(right), 'en-US')
  );
};

const getTriggerUsedPercent = (snapshots: RateLimitSnapshot[]): number | null => {
  const usedValues: number[] = [];
  for (const snapshot of snapshots) {
    for (const windowValue of [snapshot.primary, snapshot.secondary]) {
      if (!windowValue) continue;
      usedValues.push(normalizePercentValue(windowValue.usedPercent));
    }
  }
  if (usedValues.length === 0) return null;
  return Math.max(...usedValues);
};

const usedTone = (used: number): string => {
  if (used >= 100) return 'text-destructive';
  if (used >= 85) return 'text-amber-600 dark:text-amber-500';
  return 'text-muted-foreground';
};

const renderWindowBlock = (windowValue: RateLimitSnapshot['primary'], intl: IntlShape) => {
  if (!windowValue) return null;

  const usedPercent = normalizePercentValue(windowValue.usedPercent);
  const high = usedPercent >= 85;

  return (
    <div className="space-y-2 rounded-xl bg-muted/40 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="text-muted-foreground">
          {formatWindowLabel(windowValue.windowDurationMins, intl)}
        </span>
        <span className={cn('font-mono', high ? usedTone(usedPercent) : 'text-foreground')}>
          {intl.formatMessage({ id: 'editor.codex.percentUsed', defaultMessage: '{percent} used' }, { percent: formatPercent(usedPercent) })}
        </span>
      </div>
      <Progress className="h-1.5 bg-muted/70" value={usedPercent} />
      <div className="flex items-center justify-end gap-3 text-[11px] text-muted-foreground">
        <span>{intl.formatMessage({ id: 'editor.codex.resets', defaultMessage: 'Resets {time}' }, { time: formatResetTime(windowValue.resetsAt, intl) })}</span>
      </div>
    </div>
  );
};

export function CodexRateLimitsButton({
  account,
  rateLimits,
  className,
}: CodexRateLimitsButtonProps) {
  const intl = useIntl();
  const snapshots = useMemo(() => collectSnapshots(rateLimits), [rateLimits]);
  const usedPercent = getTriggerUsedPercent(snapshots);

  if (!account && snapshots.length === 0) {
    return null;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label={intl.formatMessage({ id: 'editor.codex.aria', defaultMessage: 'Open account and rate limit details' })}
          className={cn(
            'h-8 gap-2 rounded-full border-border/60 bg-background/70 px-3 text-xs text-muted-foreground shadow-none hover:bg-muted/40 hover:text-foreground',
            className,
          )}
          size="sm"
          type="button"
          variant="outline"
        >
          {usedPercent != null ? (
            <span className={cn('font-mono text-xs', usedTone(usedPercent))}>{formatPercent(usedPercent)}</span>
          ) : null}
          <Gauge className={cn('size-3.5', usedPercent != null ? usedTone(usedPercent) : undefined)} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[360px] rounded-2xl border border-border/40 bg-background/95 p-3 shadow-float backdrop-blur"
        side="top"
      >
        <div className="space-y-2.5">
          {snapshots.length > 0 ? (
            snapshots.map((snapshot) => (
              <div className="space-y-2" key={getSnapshotKey(snapshot)}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {snapshot.limitName ?? snapshot.limitId ?? intl.formatMessage({ id: 'editor.codex.default', defaultMessage: 'Default' })}
                    </p>
                    {snapshot.planType ? (
                      <p className="text-[11px] text-muted-foreground">
                        {intl.formatMessage({ id: 'editor.codex.plan', defaultMessage: 'Plan: {plan}' }, { plan: snapshot.planType })}
                      </p>
                    ) : null}
                  </div>
                  {snapshot.credits ? (
                    <div className="text-right text-[11px] text-muted-foreground">
                      <p>{snapshot.credits.unlimited
                        ? intl.formatMessage({ id: 'editor.codex.unlimitedCredits', defaultMessage: 'Unlimited credits' })
                        : intl.formatMessage({ id: 'editor.codex.credits', defaultMessage: 'Credits' })}</p>
                      {!snapshot.credits.unlimited && snapshot.credits.balance ? (
                        <p className="font-mono text-foreground">{snapshot.credits.balance}</p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {renderWindowBlock(snapshot.primary, intl)}
                {renderWindowBlock(snapshot.secondary, intl)}
              </div>
            ))
          ) : (
            <div className="rounded-2xl bg-muted/35 px-3 py-3 text-sm text-muted-foreground">
              {intl.formatMessage({ id: 'editor.codex.noData', defaultMessage: 'No rate limit data yet.' })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
