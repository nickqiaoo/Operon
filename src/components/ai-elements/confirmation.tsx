"use client";

/**
 * Confirmation, rebuilt on shadcn/ui Item (https://ui.shadcn.com/docs/ai-elements/radix/confirmation):
 * a pending approval is a question for the person, not a step the agent took,
 * so it sits outside the Trace as an Item — the question, then the answers.
 * Once answered, the call goes back to being a Tool line.
 */

import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { cn } from "@/lib/utils";
import type { ToolUIPart } from "ai";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
} from "react";

type ToolUIPartApproval =
  | {
    id: string;
    approved?: never;
    reason?: never;
  }
  | {
    id: string;
    approved: boolean;
    reason?: string;
  }
  | {
    id: string;
    approved: true;
    reason?: string;
  }
  | {
    id: string;
    approved: true;
    reason?: string;
  }
  | {
    id: string;
    approved: false;
    reason?: string;
  }
  | undefined;

interface ConfirmationContextValue {
  approval: ToolUIPartApproval;
  state: ToolUIPart["state"];
}

const ConfirmationContext = createContext<ConfirmationContextValue | null>(
  null
);

const useConfirmation = () => {
  const context = useContext(ConfirmationContext);

  if (!context) {
    throw new Error("Confirmation components must be used within Confirmation");
  }

  return context;
};

export type ConfirmationProps = ComponentProps<typeof Item> & {
  approval?: ToolUIPartApproval;
  state: ToolUIPart["state"];
  /** Leading icon, e.g. the tool's. */
  icon?: ReactNode;
};

export const Confirmation = ({
  className,
  approval,
  state,
  icon,
  children,
  ...props
}: ConfirmationProps) => {
  if (
    !approval ||
    state === "input-streaming" ||
    state === "input-available" ||
    (approval.approved === undefined && state !== "approval-requested")
  ) {
    return null;
  }

  return (
    <ConfirmationContext.Provider value={{ approval, state }}>
      <Item
        data-testid="confirmation"
        variant="outline"
        size="sm"
        className={cn("not-prose gap-3 bg-background", className)}
        {...props}
      >
        {icon && <ItemMedia variant="icon">{icon}</ItemMedia>}
        {children}
      </Item>
    </ConfirmationContext.Provider>
  );
};

export type ConfirmationTitleProps = ComponentProps<typeof ItemTitle>;

export const ConfirmationTitle = ({
  className,
  ...props
}: ConfirmationTitleProps) => (
  <ItemContent className="min-w-0">
    <ItemTitle className={cn("line-clamp-none flex-wrap font-normal [&_svg]:size-4", className)} {...props} />
  </ItemContent>
);

export interface ConfirmationRequestProps {
  children?: ReactNode;
}

export const ConfirmationRequest = ({ children }: ConfirmationRequestProps) => {
  const { state } = useConfirmation();

  // Only show when approval is requested
  if (state !== "approval-requested") {
    return null;
  }

  return children;
};

export interface ConfirmationAcceptedProps {
  children?: ReactNode;
}

export const ConfirmationAccepted = ({
  children,
}: ConfirmationAcceptedProps) => {
  const { approval, state } = useConfirmation();

  // Only show when approved and in response states
  if (
    !approval?.approved ||
    (state !== "approval-responded" &&
      state !== "output-denied" &&
      state !== "output-available")
  ) {
    return null;
  }

  return children;
};

export interface ConfirmationRejectedProps {
  children?: ReactNode;
}

export const ConfirmationRejected = ({
  children,
}: ConfirmationRejectedProps) => {
  const { approval, state } = useConfirmation();

  // Only show when rejected and in response states
  if (
    approval?.approved !== false ||
    (state !== "approval-responded" &&
      state !== "output-denied" &&
      state !== "output-available")
  ) {
    return null;
  }

  return children;
};

export type ConfirmationActionsProps = ComponentProps<"div">;

export const ConfirmationActions = ({
  className,
  ...props
}: ConfirmationActionsProps) => {
  const { state } = useConfirmation();

  // Only show when approval is requested
  if (state !== "approval-requested") {
    return null;
  }

  return (
    <ItemActions className={cn("ml-auto flex-wrap justify-end", className)} {...props} />
  );
};

export type ConfirmationActionTone = "allow" | "reject" | "neutral";

export type ConfirmationActionProps = ComponentProps<typeof Button> & {
  tone?: ConfirmationActionTone;
};

export const ConfirmationAction = ({
  className,
  tone = "neutral",
  variant,
  size = "sm",
  ...props
}: ConfirmationActionProps) => (
  <Button
    className={cn("h-8", tone === "reject" && "text-status-error hover:text-status-error", className)}
    size={size}
    type="button"
    variant={variant ?? (tone === "allow" ? "default" : "ghost")}
    {...props}
  />
);
