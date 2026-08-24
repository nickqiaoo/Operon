"use client";

import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { DetailedContextUsage, DetailedContextUsageCategory } from "@/types/context-usage";
import type { LanguageModelUsage } from "ai";
import { type ComponentProps, createContext, useContext } from "react";

const PERCENT_MAX = 100;
const ICON_RADIUS = 10;
const ICON_VIEWBOX = 24;
const ICON_CENTER = 12;
const ICON_STROKE_WIDTH = 2;
const metricTriggerClassName =
  "h-8 gap-2 rounded-full border-border/60 bg-background/70 px-3 text-xs shadow-none hover:bg-muted/40";

interface ContextSchema {
  usedTokens?: number;
  maxTokens?: number;
  usage?: LanguageModelUsage;
  chatId?: number;
  detailedContextUsage?: DetailedContextUsage;
}

const ContextContext = createContext<ContextSchema | null>(null);

const useContextValue = () => {
  const context = useContext(ContextContext);

  if (!context) {
    throw new Error("Context components must be used within Context");
  }

  return context;
};

export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema;

export const Context = ({
  usedTokens,
  maxTokens,
  usage,
  chatId,
  detailedContextUsage,
  ...props
}: ContextProps) => (
  <ContextContext.Provider
    value={{
      usedTokens,
      maxTokens,
      usage,
      chatId,
      detailedContextUsage,
    }}
  >
    <HoverCard closeDelay={300} openDelay={0} {...props} />
  </ContextContext.Provider>
);

const ContextIcon = () => {
  const { usedTokens, maxTokens } = useContextValue();
  const circumference = 2 * Math.PI * ICON_RADIUS;
  const hasPercent = usedTokens != null && maxTokens != null && maxTokens > 0;
  const usedPercent = hasPercent ? usedTokens / maxTokens : 0;
  const dashOffset = circumference * (1 - usedPercent);

  return (
    <svg
      aria-label="Model context usage"
      className="size-3.5 shrink-0"
      role="img"
      style={{ color: "currentcolor" }}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
    >
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.25"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
      {hasPercent && (
        <circle
          cx={ICON_CENTER}
          cy={ICON_CENTER}
          fill="none"
          opacity="0.7"
          r={ICON_RADIUS}
          stroke="currentColor"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          strokeWidth={ICON_STROKE_WIDTH}
          style={{ transformOrigin: "center", transform: "rotate(-90deg)" }}
        />
      )}
    </svg>
  );
};

export type ContextTriggerProps = ComponentProps<typeof Button>;

export const ContextTrigger = ({ children, ...props }: ContextTriggerProps) => {
  const { usedTokens, maxTokens, usage } = useContextValue();
  const { className, ...buttonProps } = props;
  const hasPercent = usedTokens != null && maxTokens != null && maxTokens > 0;

  const cumulativeTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  const label = hasPercent
    ? new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(usedTokens / maxTokens)
    : new Intl.NumberFormat("en-US", { notation: "compact" }).format(
        cumulativeTokens > 0 ? cumulativeTokens : (usedTokens ?? 0)
      ) + " tokens";

  return (
    <HoverCardTrigger asChild>
      {children ?? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(metricTriggerClassName, className)}
          {...buttonProps}
        >
          <span className="font-mono text-xs text-muted-foreground">
            {label}
          </span>
          <ContextIcon />
        </Button>
      )}
    </HoverCardTrigger>
  );
};

export type ContextContentProps = ComponentProps<typeof HoverCardContent>;

export const ContextContent = ({
  className,
  ...props
}: ContextContentProps) => (
  <HoverCardContent
    align="end"
    className={cn(
      "min-w-60 divide-y divide-border/50 overflow-hidden rounded-xl border-border/40 p-0 shadow-float",
      className
    )}
    {...props}
  />
);

export type ContextContentHeaderProps = ComponentProps<"div">;

export const ContextContentHeader = ({
  children,
  className,
  ...props
}: ContextContentHeaderProps) => {
  const { usedTokens, maxTokens, usage } = useContextValue();
  const hasPercent = usedTokens != null && maxTokens != null && maxTokens > 0;
  const usedPercent = hasPercent ? usedTokens / maxTokens : 0;
  const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact" }).format(n);

  const cumulativeTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  const displayUsed = hasPercent
    ? usedTokens
    : (cumulativeTokens > 0 ? cumulativeTokens : (usedTokens ?? 0));

  return (
    <div className={cn("w-full space-y-2 p-3", className)} {...props}>
      {children ?? (
        <>
          <div className="flex items-center justify-between gap-3 text-xs">
            {hasPercent ? (
              <p>{new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(usedPercent)}</p>
            ) : (
              <p className="text-muted-foreground">Token Usage</p>
            )}
            <p className="font-mono text-muted-foreground">
              {hasPercent ? `${compact(usedTokens)} / ${compact(maxTokens)}` : `${compact(displayUsed)} tokens`}
            </p>
          </div>
          {hasPercent && (
            <div className="space-y-2">
              <Progress className="bg-muted" value={usedPercent * PERCENT_MAX} />
            </div>
          )}
        </>
      )}
    </div>
  );
};

export type ContextContentBodyProps = ComponentProps<"div">;

export const ContextContentBody = ({
  children,
  className,
  ...props
}: ContextContentBodyProps) => (
  <div className={cn("w-full space-y-1.5 p-3", className)} {...props}>
    {children}
  </div>
);

export type ContextContentFooterProps = ComponentProps<"div">;

export const ContextContentFooter = ({
  children,
  className,
  ...props
}: ContextContentFooterProps) => (
  <div
    className={cn(
      "flex w-full items-center justify-between gap-3 bg-secondary p-3 text-xs",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type ContextInputUsageProps = ComponentProps<"div">;

export const ContextInputUsage = ({
  className,
  children,
  ...props
}: ContextInputUsageProps) => {
  const { usage } = useContextValue();
  const inputTokens = usage?.inputTokens ?? 0;

  if (children) {
    return children;
  }

  if (!inputTokens) {
    return null;
  }

  return (
    <div
      className={cn("flex items-center justify-between text-xs", className)}
      {...props}
    >
      <span className="text-muted-foreground">Input</span>
      <TokenCount tokens={inputTokens} />
    </div>
  );
};

export type ContextOutputUsageProps = ComponentProps<"div">;

export const ContextOutputUsage = ({
  className,
  children,
  ...props
}: ContextOutputUsageProps) => {
  const { usage } = useContextValue();
  const outputTokens = usage?.outputTokens ?? 0;

  if (children) {
    return children;
  }

  if (!outputTokens) {
    return null;
  }

  return (
    <div
      className={cn("flex items-center justify-between text-xs", className)}
      {...props}
    >
      <span className="text-muted-foreground">Output</span>
      <TokenCount tokens={outputTokens} />
    </div>
  );
};

export type ContextReasoningUsageProps = ComponentProps<"div">;

export const ContextReasoningUsage = ({
  className,
  children,
  ...props
}: ContextReasoningUsageProps) => {
  const { usage } = useContextValue();
  const reasoningTokens = usage?.outputTokenDetails?.reasoningTokens ?? usage?.reasoningTokens ?? 0;

  if (children) {
    return children;
  }

  if (!reasoningTokens) {
    return null;
  }

  return (
    <div
      className={cn("flex items-center justify-between text-xs", className)}
      {...props}
    >
      <span className="text-muted-foreground">Reasoning</span>
      <TokenCount tokens={reasoningTokens} />
    </div>
  );
};

export type ContextCacheUsageProps = ComponentProps<"div">;

export const ContextCacheUsage = ({
  className,
  children,
  ...props
}: ContextCacheUsageProps) => {
  const { usage } = useContextValue();
  const cacheRead = usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens ?? 0;
  const cacheWrite = usage?.inputTokenDetails?.cacheWriteTokens ?? 0;

  if (children) {
    return children;
  }

  if (!cacheRead && !cacheWrite) {
    return null;
  }

  return (
    <>
      {cacheRead > 0 && (
        <div
          className={cn("flex items-center justify-between text-xs", className)}
          {...props}
        >
          <span className="text-muted-foreground">Cache Read</span>
          <TokenCount tokens={cacheRead} />
        </div>
      )}
      {cacheWrite > 0 && (
        <div
          className={cn("flex items-center justify-between text-xs", className)}
          {...props}
        >
          <span className="text-muted-foreground">Cache Write</span>
          <TokenCount tokens={cacheWrite} />
        </div>
      )}
    </>
  );
};

const TokenCount = ({ tokens }: { tokens?: number }) => (
  <span className="font-mono tabular-nums">
    {tokens === undefined
      ? "—"
      : new Intl.NumberFormat("en-US", {
          notation: "compact",
        }).format(tokens)}
  </span>
);

const compact = (n: number) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);

const formatPercent = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(n);

const CategoryRow = ({ category, maxTokens }: { category: DetailedContextUsageCategory; maxTokens: number }) => {
  const percent = maxTokens > 0 ? category.tokens / maxTokens : 0;
  return (
    <>
      <span className="truncate text-muted-foreground">{category.name}</span>
      <span className="text-right font-mono tabular-nums">{compact(category.tokens)}</span>
      <span className="text-right font-mono tabular-nums text-muted-foreground">
        {formatPercent(percent)}
      </span>
    </>
  );
};

export type ContextDetailedContentProps = ComponentProps<"div">;

export const ContextDetailedContent = ({
  className,
  ...props
}: ContextDetailedContentProps) => {
  const { usedTokens, maxTokens, usage, detailedContextUsage: detailed } = useContextValue();

  // When detailed data is available (pushed via streaming metadata), show full breakdown
  if (detailed) {
    const effectiveMax = detailed.maxTokens;
    const hasFreeSpace = detailed.categories.some((c) => c.name === "Free space");
    const categoriesWithFree: DetailedContextUsageCategory[] = hasFreeSpace
      ? detailed.categories
      : [
          ...detailed.categories,
          { name: "Free space", tokens: Math.max(0, effectiveMax - detailed.totalTokens), color: "hsl(var(--muted))" },
        ];

    return (
      <div className={cn("space-y-3 p-3", className)} {...props}>
        {/* Header with progress */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">Context window</span>
            <span className="font-mono tabular-nums text-muted-foreground">
              {compact(detailed.totalTokens)} / {compact(effectiveMax)}{" "}
              ({formatPercent(detailed.percentage / PERCENT_MAX)})
            </span>
          </div>
          <Progress className="bg-muted" value={detailed.percentage} />
        </div>

        {/* Category breakdown */}
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-2 gap-y-1 text-xs">
          {categoriesWithFree.map((cat) => (
            <CategoryRow key={cat.name} category={cat} maxTokens={effectiveMax} />
          ))}
        </div>

        {/* Memory files */}
        {detailed.memoryFiles.length > 0 && (
          <div className="border-t border-border/40 pt-2">
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-2 text-xs">
              <span className="text-muted-foreground">Memory files</span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {compact(detailed.memoryFiles.reduce((s, f) => s + f.tokens, 0))}
              </span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {detailed.memoryFiles.length} files
              </span>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Fallback: standard usage breakdown when detailed data is not available
  const inputTotal = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const reasoningTokens = usage?.outputTokenDetails?.reasoningTokens ?? usage?.reasoningTokens ?? 0;
  const cacheRead = usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens ?? 0;
  const cacheWrite = usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
  // How full the window is — NOT the same number as this turn's input. `usedTokens`
  // carries the provider's own prompt-token count (see useRecentDerivedState:
  // "promptTokens from provider is authoritative"); `usage.inputTokens` is what the
  // turn was billed for, which counts cache reads and so runs far higher on a warm
  // cache. Reading the billed number here made this panel disagree with the trigger
  // right next to it — 31.9% vs 6% off the same state. Fall back to the billed
  // total only when the provider reports no prompt count at all.
  const contextTokens = usedTokens ?? inputTotal;
  const hasPercent = maxTokens != null && maxTokens > 0 && contextTokens > 0;

  return (
    <div className={cn("space-y-2 p-3", className)} {...props}>
      <div className="flex items-center justify-between gap-3 text-xs">
        {hasPercent ? (
          <p>{formatPercent(contextTokens / maxTokens)}</p>
        ) : (
          <p className="text-muted-foreground">Token Usage</p>
        )}
        <p className="font-mono text-muted-foreground">
          {hasPercent ? `${compact(contextTokens)} / ${compact(maxTokens)}` : `${compact(inputTotal || outputTokens)} tokens`}
        </p>
      </div>
      {hasPercent && <Progress className="bg-muted" value={(contextTokens / maxTokens) * PERCENT_MAX} />}
      {usage && (
        <div className="space-y-1">
          {inputTotal > 0 && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Input</span>
              <span className="font-mono tabular-nums">{compact(inputTotal)}</span>
            </div>
          )}
          {cacheRead > 0 && (
            <div className="flex items-center justify-between text-xs">
              <span className="pl-2 text-muted-foreground/70">Cache Read</span>
              <span className="font-mono tabular-nums text-muted-foreground">{compact(cacheRead)}</span>
            </div>
          )}
          {cacheWrite > 0 && (
            <div className="flex items-center justify-between text-xs">
              <span className="pl-2 text-muted-foreground/70">Cache Write</span>
              <span className="font-mono tabular-nums text-muted-foreground">{compact(cacheWrite)}</span>
            </div>
          )}
          {outputTokens > 0 && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Output</span>
              <span className="font-mono tabular-nums">{compact(outputTokens)}</span>
            </div>
          )}
          {reasoningTokens > 0 && (
            <div className="flex items-center justify-between text-xs">
              <span className="pl-2 text-muted-foreground/70">Reasoning</span>
              <span className="font-mono tabular-nums text-muted-foreground">{compact(reasoningTokens)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
