"use client";

import { Button } from "@/components/ui/button";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { cn } from "@/lib/utils";
import { CircleCheckIcon, CircleDotIcon, CircleIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

/**
 * Queue, rebuilt on shadcn/ui Trace (https://ui.shadcn.com/docs/ai-elements/radix/queue):
 * the agent's todo list as Trace lines, split into sections ("2 to do",
 * "1 completed") that each open onto their items.
 */

export type QueueProps = ComponentProps<typeof Trace>;

export const Queue = ({ className, ...props }: QueueProps) => (
  <Trace data-slot="queue" className={className} {...props} />
);

export type QueueSectionProps = Omit<ComponentProps<typeof TraceCollapsible>, "open" | "onOpenChange">;

export const QueueSection = ({ defaultOpen = true, ...props }: QueueSectionProps) => (
  <TraceCollapsible defaultOpen={defaultOpen} {...props} />
);

export const QueueSectionTrigger = TraceCollapsibleTrigger;

export type QueueSectionLabelProps = Omit<ComponentProps<typeof TraceLine>, "children"> & {
  count?: number;
  label: string;
  icon?: ReactNode;
};

export const QueueSectionLabel = ({ count, label, icon, ...props }: QueueSectionLabelProps) => (
  <TraceLine {...props}>
    {icon && <TraceIcon>{icon}</TraceIcon>}
    <TraceTitle>
      {count === undefined ? label : `${count} ${label}`}
    </TraceTitle>
  </TraceLine>
);

export const QueueSectionContent = TraceCollapsibleContent;

export type QueueListProps = ComponentProps<typeof Trace>;

export const QueueList = (props: QueueListProps) => <Trace {...props} />;

export type QueueItemProps = ComponentProps<typeof TraceLine> & {
  completed?: boolean;
  inProgress?: boolean;
};

/** A todo line; it shimmers (`running`) while in progress. */
export const QueueItem = ({ completed, inProgress, status, ...props }: QueueItemProps) => (
  <TraceLine
    status={status ?? (inProgress && !completed ? "running" : undefined)}
    {...props}
  />
);

export type QueueItemIndicatorProps = ComponentProps<typeof TraceIcon> & {
  completed?: boolean;
  inProgress?: boolean;
};

export const QueueItemIndicator = ({
  completed = false,
  inProgress = false,
  children,
  ...props
}: QueueItemIndicatorProps) => (
  <TraceIcon {...props}>
    {children ?? (completed ? <CircleCheckIcon /> : inProgress ? <CircleDotIcon /> : <CircleIcon />)}
  </TraceIcon>
);

export type QueueItemContentProps = ComponentProps<typeof TraceTitle> & {
  completed?: boolean;
};

export const QueueItemContent = ({ completed: _completed, ...props }: QueueItemContentProps) => (
  <TraceTitle {...props} />
);

export type QueueItemDescriptionProps = ComponentProps<typeof TraceDescription>;

export const QueueItemDescription = TraceDescription;

export type QueueItemActionsProps = ComponentProps<"span">;

export const QueueItemActions = ({ className, ...props }: QueueItemActionsProps) => (
  <span className={cn("flex shrink-0 items-center gap-0.5", className)} {...props} />
);

export type QueueItemActionProps = Omit<ComponentProps<typeof Button>, "variant" | "size">;

export const QueueItemAction = ({ className, ...props }: QueueItemActionProps) => (
  <Button
    className={cn("text-muted-foreground hover:text-foreground", className)}
    size="icon-xs"
    type="button"
    variant="ghost"
    {...props}
  />
);
