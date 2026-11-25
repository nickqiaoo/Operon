import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useIntl } from 'react-intl';
import { ProviderIcon } from '@/components/icons/ProviderLabel';
import { usageLevel } from '@/components/editor/components/rate-limit-tone';
import { ArrowUpRight, Loader2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CLOCK_24H } from '@/lib/format';
import { openExternalUrl } from '@/lib/open-external';
import { cn } from '@/lib/utils';
import { useAccountUsage, type ProviderUsage } from './useAccountUsage';

/**
 * One ring, cut in two like a dual-SIM status bar: the short top arc is the
 * 5-hour window, the long bottom arc the week. Each arc fills with what is
 * *left*, so a whole ring is a fresh budget.
 *
 * Angles are degrees clockwise from 12 o'clock. The gaps are wide enough to
 * survive the round caps (each cap eats ~3.9° at this radius).
 */
const SIZE = 28;
const R = 12.75;
// Thin on purpose: a heavy stroke's round caps eat the gaps and the spent
// stretch, and the ring stops reading as a gauge.
const STROKE = 1.75;
// The top arc is wide enough (104°) that a fifth spent is a visible bite.
const TOP_ARC = { from: -52, to: 52 };
const BOTTOM_ARC = { from: 80, to: 280 };

/**
 * The top wedge — the one the pointer must be in to read the 5-hour window —
 * runs out to the middle of each gap, so the hit areas meet exactly where the
 * two arcs part and the reading follows the arc under the pointer.
 */
const TOP_WEDGE_HALF = (TOP_ARC.to + BOTTOM_ARC.from) / 2;

const point = (deg: number) => {
  const rad = (deg * Math.PI) / 180;
  return `${(SIZE / 2 + R * Math.sin(rad)).toFixed(3)} ${(SIZE / 2 - R * Math.cos(rad)).toFixed(3)}`;
};

/**
 * Both arcs are drawn starting from their left-hand end, so the filled part
 * (what is left) grows out of the left and the spent part opens up on the
 * right. The top arc therefore runs clockwise (left → right over the top) and
 * the bottom one counter-clockwise (left → right under the bottom).
 */
const arcPath = ({ from, to }: { from: number; to: number }, clockwise: boolean) => {
  const [start, end] = clockwise ? [from, to] : [to, from];
  return `M ${point(start)} A ${R} ${R} 0 ${to - from > 180 ? 1 : 0} ${clockwise ? 1 : 0} ${point(end)}`;
};

/**
 * Quiet while there is headroom, then the accent ramp — same thresholds as
 * the composer badges. Neutral rather than green at rest: the rings are
 * ambient chrome and should not be the loudest thing in the rail on a normal day.
 */
const arcTone = (used: number, active: boolean): string => {
  switch (usageLevel(used)) {
    case 'critical':
      return 'text-accent-red';
    case 'warn':
      return 'text-accent-warm';
    default:
      // The arc under the pointer comes up to full foreground.
      return active ? 'text-foreground' : 'text-foreground/80';
  }
};

type ArcState = 'rest' | 'active' | 'dimmed';

/**
 * The arc under the pointer grows outward a little, about the ring's centre
 * (so it lifts off the circle instead of drifting), while the other one stays
 * put and steps back — the reading points at one arc, not at the whole icon.
 */
const ARC_ACTIVE_SCALE = 1.12;

type WindowKey = 'short' | 'long';

function Arc({ d, used, drawn, state }: { d: string; used: number | undefined; drawn: boolean; state: ArcState }) {
  const remaining = used === undefined ? 0 : Math.max(0, 100 - used);
  return (
    <g
      className={cn(
        'transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none',
        state === 'dimmed' && 'opacity-45',
      )}
      style={{
        transformBox: 'view-box',
        transformOrigin: 'center',
        transform: state === 'active' ? `scale(${ARC_ACTIVE_SCALE})` : undefined,
      }}
    >
      {/* The spent stretch has to show as a paler arc, not as nothing: at this
          size a bare stretch reads as one more structural gap, and a 15%
          bite on the top arc vanishes into it. */}
      <path d={d} fill="none" strokeWidth={STROKE} strokeLinecap="round" className="stroke-foreground/15" />
      {used !== undefined && remaining > 0 && (
        <path
          d={d}
          pathLength={100}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinecap="round"
          // Drawn in from empty on mount, then eased to each new reading.
          strokeDasharray={`${drawn ? remaining : 0} 100`}
          className={cn(
            'motion-safe:transition-[stroke-dasharray,color] motion-safe:duration-700 motion-safe:ease-out',
            arcTone(used, state === 'active'),
          )}
        />
      )}
    </g>
  );
}

const PROVIDER_NAME: Record<string, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
};

/** Where each provider lets you see and buy more of the same budget. */
const MANAGE_USAGE_URL: Record<string, string> = {
  'claude-code': 'https://claude.ai/settings/usage',
  codex: 'https://chatgpt.com/settings/usage',
};

/** 'max_20x' → 'Max 20x'. Providers report the plan as a lower-case slug. */
const planLabel = (plan: string) => {
  const words = plan.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const left = (used: number) => Math.round(Math.max(0, 100 - used));

const startOfDay = (ms: number) => {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/**
 * "at 14:30" today, "tomorrow 09:00", otherwise "Nov 27, 10:00" — the 5-hour
 * window almost always lands on the first, the week on the last.
 */
function useResetLabel() {
  const intl = useIntl();
  return (resetsAt: number | undefined): string | null => {
    if (!resetsAt) return null;
    const time = intl.formatDate(resetsAt, { hour: '2-digit', minute: '2-digit', ...CLOCK_24H });
    const days = Math.round((startOfDay(resetsAt) - startOfDay(Date.now())) / 86_400_000);
    if (days <= 0) {
      return intl.formatMessage({ id: 'usageRail.resetsToday', defaultMessage: 'Resets at {time}' }, { time });
    }
    if (days === 1) {
      return intl.formatMessage({ id: 'usageRail.resetsTomorrow', defaultMessage: 'Resets tomorrow {time}' }, { time });
    }
    const date = intl.formatDate(resetsAt, { month: 'short', day: 'numeric' });
    return intl.formatMessage({ id: 'usageRail.resetsOn', defaultMessage: 'Resets {date}, {time}' }, { date, time });
  };
}

function DetailRow({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  return (
    <div className="px-3.5 py-1.5">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span>{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{hint}</div> : null}
    </div>
  );
}

/** What a click on the ring opens: both windows, when they reset, and the plan they come from. */
function UsageDetails({ usage, onNavigate }: { usage: ProviderUsage; onNavigate: () => void }) {
  const intl = useIntl();
  const resetLabel = useResetLabel();
  const name = PROVIDER_NAME[usage.providerId] ?? usage.providerId;
  const manageUrl = MANAGE_USAGE_URL[usage.providerId];
  const percentLeft = (used: number) =>
    intl.formatMessage({ id: 'usageRail.percentLeft', defaultMessage: '{percent}% left' }, { percent: left(used) });

  return (
    <>
      <div className="px-3.5 pb-2 pt-2.5 text-xs text-muted-foreground">
        {usage.plan
          ? intl.formatMessage(
              { id: 'usageRail.planHeader', defaultMessage: '{provider} · {plan} plan' },
              { provider: name, plan: planLabel(usage.plan) },
            )
          : name}
      </div>
      <div className="border-t border-border/40 py-1.5">
        {usage.shortPercent !== undefined && (
          <DetailRow
            label={intl.formatMessage({ id: 'usageRail.shortTitle', defaultMessage: '5-hour limit' })}
            value={percentLeft(usage.shortPercent)}
            hint={resetLabel(usage.shortResetsAt)}
          />
        )}
        {usage.longPercent !== undefined && (
          <DetailRow
            label={intl.formatMessage({ id: 'usageRail.longTitle', defaultMessage: 'Weekly limit' })}
            value={percentLeft(usage.longPercent)}
            hint={resetLabel(usage.longResetsAt)}
          />
        )}
        {usage.credits && (
          <DetailRow
            label={intl.formatMessage({ id: 'usageRail.credits', defaultMessage: 'Credits' })}
            value={
              usage.credits.unlimited
                ? intl.formatMessage({ id: 'usageRail.unlimited', defaultMessage: 'Unlimited' })
                : (usage.credits.balance ?? '—')
            }
          />
        )}
      </div>
      {manageUrl && (
        <div className="border-t border-border/40 p-1.5">
          <button
            type="button"
            onClick={() => {
              openExternalUrl(manageUrl);
              onNavigate();
            }}
            className="flex h-8 w-full items-center justify-between gap-2 rounded-lg px-2 text-sm outline-none transition-colors hover:bg-row-hover focus-visible:bg-row-hover"
          >
            {intl.formatMessage({ id: 'usageRail.manage', defaultMessage: 'Manage usage' })}
            <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
      )}
    </>
  );
}

function ProviderUsageRing({ usage }: { usage: ProviderUsage }) {
  const intl = useIntl();
  const name = PROVIDER_NAME[usage.providerId] ?? usage.providerId;
  const [drawn, setDrawn] = useState(false);
  // `open` is the hover tooltip (mouse only); `detailsOpen` the click popover.
  const [open, setOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [active, setActive] = useState<WindowKey>('short');
  // Set when the popover is dismissed by a click elsewhere, so focus is not
  // handed back to the ring — Radix's tooltip would take that focus as a cue
  // to open. Escape still hands focus back, which keyboard users need.
  const dismissedByPointer = useRef(false);
  const ringRef = useRef<HTMLSpanElement>(null);

  // One frame at 0 first, so the transition has somewhere to start from.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // The reading follows the arc under the pointer: the angle from the ring's
  // centre picks the wedge. A finger has no hover, so touch goes straight to
  // the popover instead.
  const pickWindow = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse') return;
    const ring = ringRef.current?.getBoundingClientRect();
    if (!ring) return;
    const dx = event.clientX - (ring.left + ring.width / 2);
    const dy = event.clientY - (ring.top + ring.height / 2);
    // Dead centre (on the logo) has no direction: keep the current reading.
    if (dx * dx + dy * dy < 4) return;
    const fromTop = Math.abs((Math.atan2(dx, -dy) * 180) / Math.PI);
    const next: WindowKey = fromTop <= TOP_WEDGE_HALF ? 'short' : 'long';
    setActive((current) => (current === next ? current : next));
  };

  // Literal ids: formatjs extracts statically.
  const shortLabel =
    usage.shortPercent === undefined
      ? ''
      : intl.formatMessage(
          { id: 'usageRail.shortLeft', defaultMessage: '5 hours · {percent}% left' },
          { percent: left(usage.shortPercent) },
        );
  const longLabel =
    usage.longPercent === undefined
      ? ''
      : intl.formatMessage(
          { id: 'usageRail.longLeft', defaultMessage: 'Weekly · {percent}% left' },
          { percent: left(usage.longPercent) },
        );
  // A window with no reading falls back to the other one.
  const shown: WindowKey = active === 'short' ? (shortLabel ? 'short' : 'long') : longLabel ? 'long' : 'short';
  const label = shown === 'short' ? shortLabel : longLabel;
  const tooltipOpen = open && !detailsOpen;
  const arcState = (key: WindowKey): ArcState => (!tooltipOpen ? 'rest' : shown === key ? 'active' : 'dimmed');

  return (
    <Popover
      open={detailsOpen}
      onOpenChange={(next) => {
        setDetailsOpen(next);
        if (next) setOpen(false);
      }}
    >
      <Tooltip delayDuration={0} disableHoverableContent open={tooltipOpen} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`${name}: ${[shortLabel, longLabel].filter(Boolean).join(', ')}`}
              data-testid={`rail-usage-${usage.providerId}`}
              data-window={tooltipOpen ? shown : undefined}
              onPointerEnter={pickWindow}
              onPointerMove={pickWindow}
              onKeyDown={(event) => {
                // Keyboard: up / down step between the two arcs.
                if (event.key === 'ArrowUp') setActive('short');
                else if (event.key === 'ArrowDown') setActive('long');
                else return;
                event.preventDefault();
              }}
              // The hover plate is the whole 40px cell, not the nav items' inset 32px
              // one: the ring is 28px, and a plate it nearly fills reads as a disc
              // stuck on top of it rather than as a highlight around it.
              className={cn(
                'flex size-10 items-center justify-center self-center rounded-xl outline-none transition-colors hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring/50',
                detailsOpen && 'bg-row-selected',
              )}
            >
              <span ref={ringRef} className="relative flex size-7 items-center justify-center">
                <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="absolute inset-0 overflow-visible" aria-hidden>
                  <Arc d={arcPath(TOP_ARC, true)} used={usage.shortPercent} drawn={drawn} state={arcState('short')} />
                  <Arc d={arcPath(BOTTOM_ARC, false)} used={usage.longPercent} drawn={drawn} state={arcState('long')} />
                </svg>
                <span className="opacity-70">
                  <ProviderIcon id={usage.providerId} size={11} />
                </span>
              </span>
            </button>
          </TooltipTrigger>
        </PopoverTrigger>
        <TooltipContent side="right" className="overflow-hidden">
          {/* Swapped in place, no transition: it has to keep up with the pointer. */}
          <span className="block tabular-nums">{label}</span>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="right"
        align="end"
        sideOffset={8}
        data-testid={`rail-usage-details-${usage.providerId}`}
        className="w-64 p-0"
        onPointerDownOutside={() => {
          dismissedByPointer.current = true;
        }}
        onCloseAutoFocus={(event) => {
          if (dismissedByPointer.current) event.preventDefault();
          dismissedByPointer.current = false;
        }}
      >
        <UsageDetails usage={usage} onNavigate={() => setDetailsOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Account quota for every signed-in provider, at the head of the rail's bottom
 * group: one split ring per provider, its logo in the middle. It is the app's,
 * not a conversation's, so it sits with the app-level chrome.
 */
export function AccountUsageRail({ className }: { className?: string }) {
  const { providers, loadingCodex } = useAccountUsage();
  if (!loadingCodex && providers.length === 0) return null;
  return (
    <div data-testid="rail-usage" className={cn('flex flex-col', className)}>
      {loadingCodex && <Loader2 role="progressbar" aria-label="Codex" className="mx-auto my-1 size-4 animate-spin text-muted-foreground" />}
      {providers.map((usage) => (
        <ProviderUsageRing key={usage.providerId} usage={usage} />
      ))}
    </div>
  );
}
