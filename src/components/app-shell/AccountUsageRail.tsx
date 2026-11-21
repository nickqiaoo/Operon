import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useIntl } from 'react-intl';
import { ProviderIcon } from '@/components/icons/ProviderLabel';
import { usageLevel } from '@/components/editor/components/rate-limit-tone';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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

function ProviderUsageRing({ usage }: { usage: ProviderUsage }) {
  const intl = useIntl();
  const name = PROVIDER_NAME[usage.providerId] ?? usage.providerId;
  const [drawn, setDrawn] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<WindowKey>('short');
  const ringRef = useRef<HTMLSpanElement>(null);

  // One frame at 0 first, so the transition has somewhere to start from.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // The reading follows the arc under the pointer: the angle from the ring's
  // centre picks the wedge.
  const pickWindow = (event: PointerEvent<HTMLElement>) => {
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

  const left = (used: number) => Math.round(Math.max(0, 100 - used));
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

  return (
    <Tooltip
      delayDuration={0}
      disableHoverableContent
      open={open}
      onOpenChange={setOpen}
    >
      <TooltipTrigger asChild>
        <div
          role="img"
          tabIndex={0}
          aria-label={`${name}: ${[shortLabel, longLabel].filter(Boolean).join(', ')}`}
          data-testid={`rail-usage-${usage.providerId}`}
          data-window={open ? shown : undefined}
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
          className="flex size-10 items-center justify-center self-center rounded-xl outline-none transition-colors hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span
            ref={ringRef}
            className="relative flex size-7 items-center justify-center"
          >
            <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="absolute inset-0 overflow-visible" aria-hidden>
              <Arc d={arcPath(TOP_ARC, true)} used={usage.shortPercent} drawn={drawn} state={!open ? 'rest' : shown === 'short' ? 'active' : 'dimmed'} />
              <Arc d={arcPath(BOTTOM_ARC, false)} used={usage.longPercent} drawn={drawn} state={!open ? 'rest' : shown === 'long' ? 'active' : 'dimmed'} />
            </svg>
            <span className="opacity-70">
              <ProviderIcon id={usage.providerId} size={11} />
            </span>
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" className="overflow-hidden">
        {/* Swapped in place, no transition: it has to keep up with the pointer. */}
        <span className="block tabular-nums">{label}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Account quota for every signed-in provider, at the head of the rail's bottom
 * group: one split ring per provider, its logo in the middle. It is the app's,
 * not a conversation's, so it sits with the app-level chrome.
 */
export function AccountUsageRail({ className }: { className?: string }) {
  const { providers } = useAccountUsage();
  if (providers.length === 0) return null;
  return (
    <div data-testid="rail-usage" className={cn('flex flex-col', className)}>
      {providers.map((usage) => (
        <ProviderUsageRing key={usage.providerId} usage={usage} />
      ))}
    </div>
  );
}
