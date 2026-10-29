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
import { safeCode } from "@/lib/streamdown-code";
import { cn } from "@/lib/utils";
import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { BrainIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, memo, useContext, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

/**
 * Reasoning, rebuilt on shadcn/ui Trace (https://ui.shadcn.com/docs/ai-elements/radix/reasoning):
 * one line that reads "Thinking" and opens while the model thinks, then
 * "Thought" with how long it took, and closes when it is done — unless the
 * person opened or closed it, in which case their choice wins.
 */

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
  /** False when there is no thought text to show, so the line does not open. */
  collapsible: boolean;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);
const code = safeCode;

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = Omit<ComponentProps<typeof TraceCollapsible>, "open" | "onOpenChange" | "defaultOpen"> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
  /**
   * The thought text is empty (some models only report that they thought).
   * Once streaming ends the line is then a plain step with nothing to open.
   */
  empty?: boolean;
};

const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open: openProp,
    defaultOpen,
    onOpenChange,
    duration: durationProp,
    empty = false,
    children,
    ...props
  }: ReasoningProps) => {
    const collapsible = isStreaming || !empty;
    // undefined until the person toggles it; until then it follows the stream.
    const [userOpen, setUserOpen] = useState<boolean | undefined>(defaultOpen);
    const isOpen = collapsible && (openProp ?? userOpen ?? isStreaming);
    const setIsOpen = (next: boolean) => {
      setUserOpen(next);
      onOpenChange?.(next);
    };

    const startRef = useRef<number | null>(null);
    const [measured, setMeasured] = useState<number | undefined>(undefined);
    useEffect(() => {
      if (isStreaming) {
        startRef.current ??= Date.now();
      } else if (startRef.current !== null) {
        setMeasured(Math.ceil((Date.now() - startRef.current) / MS_IN_S));
        startRef.current = null;
      }
    }, [isStreaming]);
    const duration = durationProp ?? measured;

    return (
      <ReasoningContext.Provider value={{ isStreaming, isOpen, setIsOpen, duration, collapsible }}>
        <Trace>
          <TraceCollapsible
            data-testid="reasoning"
            className={cn("not-prose", className)}
            open={isOpen}
            onOpenChange={setIsOpen}
            {...props}
          >
            {children}
          </TraceCollapsible>
        </Trace>
      </ReasoningContext.Provider>
    );
  }
);

export type ReasoningTriggerProps = Omit<ComponentProps<typeof TraceCollapsibleTrigger>, "children"> & {
  children?: ReactNode;
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

const defaultGetThinkingMessage = (isStreaming: boolean) =>
  isStreaming ? "Thinking" : "Thought";

export const ReasoningTrigger = memo(
  ({
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, duration, collapsible } = useReasoning();
    const line = children ?? (
      <TraceLine status={isStreaming ? "running" : undefined}>
        {/* A fixed icon: "still thinking" is the title's shimmer, as on every other
            step line. The one spinner in the turn is the Working marker below. */}
        <TraceIcon>
          <BrainIcon />
        </TraceIcon>
        <TraceTitle>{getThinkingMessage(isStreaming, duration)}</TraceTitle>
        {!isStreaming && duration ? <TraceDescription>{duration}s</TraceDescription> : null}
      </TraceLine>
    );

    if (!collapsible) return line;
    return <TraceCollapsibleTrigger {...props}>{line}</TraceCollapsibleTrigger>;
  }
);

export type ReasoningContentProps = Omit<ComponentProps<typeof TraceCollapsibleContent>, "children"> & {
  children: string;
};

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => {
    const { collapsible } = useReasoning();
    if (!collapsible) return null;
    return (
      <TraceCollapsibleContent className={cn("text-sm", className)} {...props}>
        <Streamdown plugins={{ code, mermaid, math, cjk }} controls={{ code: false }}>
          {children}
        </Streamdown>
      </TraceCollapsibleContent>
    );
  }
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
