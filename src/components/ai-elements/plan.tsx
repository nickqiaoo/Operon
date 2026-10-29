"use client";

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
import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext } from "react";

/**
 * Plan, rebuilt on shadcn/ui Trace (https://ui.shadcn.com/docs/ai-elements/radix/plan):
 * one line ("Plan: …", "2 of 4 done") that opens onto the plan. The whole line
 * is the trigger, so PlanTrigger renders only its children, and a PlanAction
 * goes next to the line rather than inside it.
 */

type PlanContextValue = {
  isStreaming: boolean;
};

const PlanContext = createContext<PlanContextValue | null>(null);

const usePlan = () => {
  const context = useContext(PlanContext);
  if (!context) {
    throw new Error("Plan components must be used within Plan");
  }
  return context;
};

export type PlanProps = Omit<ComponentProps<typeof TraceCollapsible>, "open" | "onOpenChange"> & {
  isStreaming?: boolean;
};

export const Plan = ({ className, isStreaming = false, children, ...props }: PlanProps) => (
  <PlanContext.Provider value={{ isStreaming }}>
    <Trace>
      <TraceCollapsible data-slot="plan" className={cn("not-prose", className)} {...props}>
        {children}
      </TraceCollapsible>
    </Trace>
  </PlanContext.Provider>
);

export type PlanHeaderProps = Omit<ComponentProps<typeof TraceCollapsibleTrigger>, "children"> & {
  /** Leading icon. */
  icon?: ReactNode;
  children?: ReactNode;
};

export const PlanHeader = ({ icon, children, ...props }: PlanHeaderProps) => {
  const { isStreaming } = usePlan();
  return (
    <TraceCollapsibleTrigger {...props}>
      <TraceLine status={isStreaming ? "running" : undefined}>
        {icon && <TraceIcon>{icon}</TraceIcon>}
        {children}
      </TraceLine>
    </TraceCollapsibleTrigger>
  );
};

export type PlanTitleProps = ComponentProps<typeof TraceTitle>;

export const PlanTitle = (props: PlanTitleProps) => <TraceTitle {...props} />;

export type PlanDescriptionProps = ComponentProps<typeof TraceDescription>;

export const PlanDescription = (props: PlanDescriptionProps) => <TraceDescription {...props} />;

export type PlanContentProps = ComponentProps<typeof TraceCollapsibleContent>;

export const PlanContent = (props: PlanContentProps) => <TraceCollapsibleContent {...props} />;
