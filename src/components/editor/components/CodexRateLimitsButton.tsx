'use client';

import { Gauge } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useIntl, type IntlShape } from 'react-intl';
import { MobileSheet } from '@/components/mobile/MobileSheet';
import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Progress } from '@/components/ui/progress';
import { nativeUsageTones, usageBarTone, usageTextTone } from './rate-limit-tone';
import { cn } from '@/lib/utils';
import { hasNativeTabBar, NativeShell, type NativeInfoSection } from '@/lib/native';
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

const renderWindowBlock = (windowValue: RateLimitSnapshot['primary'], intl: IntlShape) => {
  if (!windowValue) return null;

  const usedPercent = normalizePercentValue(windowValue.usedPercent);

  return (
    <div className="space-y-2 rounded-xl bg-muted/40 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="text-muted-foreground">
          {formatWindowLabel(windowValue.windowDurationMins, intl)}
        </span>
        <span className={cn('font-mono', usageTextTone(usedPercent, 'text-foreground'))}>
          {intl.formatMessage({ id: 'editor.codex.percentUsed', defaultMessage: '{percent} used' }, { percent: formatPercent(usedPercent) })}
        </span>
      </div>
      <Progress className="h-1.5 bg-muted/70" indicatorClassName={usageBarTone(usedPercent)} value={usedPercent} />
      <div className="flex items-center justify-end gap-3 text-[11px] text-muted-foreground">
        <span>{intl.formatMessage({ id: 'editor.codex.resets', defaultMessage: 'Resets {time}' }, { time: formatResetTime(windowValue.resetsAt, intl) })}</span>
      </div>
    </div>
  );
};

/** Shared hover-card / sheet body — each limit with its windows. */
function CodexRateLimitsContent({ snapshots }: { snapshots: RateLimitSnapshot[] }) {
  const intl = useIntl();
  return (
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
        <div className="rounded-lg bg-muted/35 px-3 py-3 text-sm text-muted-foreground">
          {intl.formatMessage({ id: 'editor.codex.noData', defaultMessage: 'No rate limit data yet.' })}
        </div>
      )}
    </div>
  );
}

const triggerClassName =
  'h-8 gap-2 rounded-full border-border/60 bg-background/70 px-3 text-xs text-muted-foreground shadow-none hover:bg-muted/40 hover:text-foreground';

function TriggerContent({ usedPercent }: { usedPercent: number | null }) {
  return (
    <>
      {usedPercent != null ? (
        <span className={cn('font-mono text-xs', usageTextTone(usedPercent))}>{formatPercent(usedPercent)}</span>
      ) : null}
      <Gauge className={cn('size-3.5', usedPercent != null ? usageTextTone(usedPercent) : undefined)} />
    </>
  );
}

/** Desktop: account and rate limits on hover, like the context usage chip beside it. */
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
    <HoverCard closeDelay={300} openDelay={0}>
      <HoverCardTrigger asChild>
        <Button
          aria-label={intl.formatMessage({ id: 'editor.codex.aria', defaultMessage: 'Open account and rate limit details' })}
          className={cn(triggerClassName, className)}
          size="sm"
          type="button"
          variant="outline"
        >
          <TriggerContent usedPercent={usedPercent} />
        </Button>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        className="w-[360px] rounded-xl border border-border/40 bg-background/95 p-3 shadow-float backdrop-blur"
        side="top"
      >
        <CodexRateLimitsContent snapshots={snapshots} />
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * Mobile: touch has no hover, so the same trigger opens a sheet on tap — the
 * native info sheet in the packaged apps, a web bottom sheet otherwise.
 */
export function MobileCodexRateLimits({
  account,
  rateLimits,
  className,
}: CodexRateLimitsButtonProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const snapshots = useMemo(() => collectSnapshots(rateLimits), [rateLimits]);
  const usedPercent = getTriggerUsedPercent(snapshots);

  const title = intl.formatMessage({ id: 'editor.codex.title', defaultMessage: 'Rate limits' });

  const openSheet = () => {
    if (!hasNativeTabBar()) {
      setOpen(true);
      return;
    }
    const namePrefix = snapshots.length > 1;
    const sections: NativeInfoSection[] = snapshots.flatMap((snapshot) => {
      const name = getSnapshotLabel(snapshot);
      const windowSections = [snapshot.primary, snapshot.secondary].flatMap((windowValue) => {
        if (!windowValue) return [];
        const used = normalizePercentValue(windowValue.usedPercent);
        const label = formatWindowLabel(windowValue.windowDurationMins, intl);
        return [{
          header: namePrefix ? `${name} · ${label}` : label,
          value: intl.formatMessage({ id: 'editor.codex.percentUsed', defaultMessage: '{percent} used' }, { percent: formatPercent(used) }),
          progress: used / 100,
          ...nativeUsageTones(used),
          footer: intl.formatMessage({ id: 'editor.codex.resets', defaultMessage: 'Resets {time}' }, { time: formatResetTime(windowValue.resetsAt, intl) }),
        }];
      });
      const credits = snapshot.credits;
      if (!credits) return windowSections;
      return [
        ...windowSections,
        {
          rows: [{
            label: credits.unlimited
              ? intl.formatMessage({ id: 'editor.codex.unlimitedCredits', defaultMessage: 'Unlimited credits' })
              : intl.formatMessage({ id: 'editor.codex.credits', defaultMessage: 'Credits' }),
            value: !credits.unlimited && credits.balance ? String(credits.balance) : undefined,
          }],
        },
      ];
    });
    const plan = snapshots.find((snapshot) => snapshot.planType)?.planType;
    void NativeShell.presentInfoSheet({
      title,
      caption: plan
        ? intl.formatMessage({ id: 'editor.codex.plan', defaultMessage: 'Plan: {plan}' }, { plan })
        : undefined,
      sections,
    }).catch(() => setOpen(true));
  };

  if (!account && snapshots.length === 0) {
    return null;
  }

  return (
    <>
      <Button
        aria-label={intl.formatMessage({ id: 'editor.codex.aria', defaultMessage: 'Open account and rate limit details' })}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(triggerClassName, className)}
        onClick={openSheet}
        size="sm"
        type="button"
        variant="outline"
      >
        <TriggerContent usedPercent={usedPercent} />
      </Button>
      <MobileSheet open={open} onClose={() => setOpen(false)} title={title}>
        <CodexRateLimitsContent snapshots={snapshots} />
      </MobileSheet>
    </>
  );
}
