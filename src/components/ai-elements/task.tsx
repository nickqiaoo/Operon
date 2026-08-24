"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { openWorkspaceFilePreview } from "@/lib/workspace-file-preview";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, SearchIcon } from "lucide-react";
import type { ComponentProps, MouseEvent } from "react";
import { useCallback } from "react";

export type TaskItemFileProps = ComponentProps<"div"> & {
  filePath?: string;
};

export const TaskItemFile = ({
  children,
  className,
  filePath,
  onClick,
  ...props
}: TaskItemFileProps) => {
  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (onClick) {
        onClick(e);
        return;
      }
      if (!filePath) return;
      e.stopPropagation();
      openWorkspaceFilePreview(filePath);
    },
    [filePath, onClick]
  );

  const isClickable = Boolean(filePath) || Boolean(onClick);

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-muted/50 px-1.5 py-0.5 font-mono text-muted-foreground text-xs",
        isClickable && "cursor-pointer hover:bg-muted hover:text-foreground transition-colors",
        className
      )}
      onClick={isClickable ? handleClick : undefined}
      {...props}
    >
      {children}
    </div>
  );
};

export type TaskItemProps = ComponentProps<"div">;

export const TaskItem = ({ children, className, ...props }: TaskItemProps) => (
  <div className={cn("text-muted-foreground text-sm", className)} {...props}>
    {children}
  </div>
);

export type TaskProps = ComponentProps<typeof Collapsible>;

export const Task = ({
  defaultOpen = true,
  className,
  open,
  ...props
}: TaskProps) => (
  <Collapsible
    data-testid="task"
    className={cn(className)}
    // Controlled (`open` provided) and uncontrolled (`defaultOpen`) are mutually
    // exclusive in Radix; only pass one to avoid the dev warning.
    {...(open === undefined ? { defaultOpen } : { open })}
    {...props}
  />
);

export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
};

export const TaskTrigger = ({
  children,
  className,
  title,
  ...props
}: TaskTriggerProps) => (
  <CollapsibleTrigger asChild className={cn("group", className)} {...props}>
    {children ?? (
      <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
        <SearchIcon className="size-4" />
        <p className="text-sm">{title}</p>
        <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
      </div>
    )}
  </CollapsibleTrigger>
);

export type TaskContentProps = ComponentProps<typeof CollapsibleContent>;

export const TaskContent = ({
  children,
  className,
  ...props
}: TaskContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  >
    <div className="mt-4 space-y-2 border-muted border-l-2 pl-4">
      {children}
    </div>
  </CollapsibleContent>
);
