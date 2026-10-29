"use client";

import { Button } from "@/components/ui/button";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { BookmarkIcon, type LucideProps } from "lucide-react";
import type { ComponentProps } from "react";

/**
 * Checkpoint, rebuilt on shadcn/ui Marker (https://ui.shadcn.com/docs/ai-elements/radix/checkpoint):
 * a point in the conversation you can return to, drawn as a separator line
 * with its label and a small Restore-style button in the middle.
 */

export type CheckpointProps = ComponentProps<typeof Marker>;

export const Checkpoint = ({ className, children, ...props }: CheckpointProps) => (
  <Marker variant="separator" className={cn("text-xs", className)} {...props}>
    <MarkerContent className="flex items-center gap-1.5">{children}</MarkerContent>
  </Marker>
);

export type CheckpointIconProps = LucideProps;

export const CheckpointIcon = ({ className, children, ...props }: CheckpointIconProps) => (
  <MarkerIcon className="size-3.5 [&_svg:not([class*='size-'])]:size-3.5">
    {children ?? <BookmarkIcon className={className} {...props} />}
  </MarkerIcon>
);

export type CheckpointTriggerProps = ComponentProps<typeof Button> & {
  tooltip?: string;
};

export const CheckpointTrigger = ({
  children,
  variant = "outline",
  size = "xs",
  tooltip,
  ...props
}: CheckpointTriggerProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
    </Button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent align="start" side="bottom">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
};
