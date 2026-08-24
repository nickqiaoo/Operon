"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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

export type ConfirmationProps = ComponentProps<typeof Alert> & {
  approval?: ToolUIPartApproval;
  state: ToolUIPart["state"];
};

export const Confirmation = ({
  className,
  approval,
  state,
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
      <div className="px-4 pb-4">
        <Alert
          data-testid="confirmation"
          className={cn(
            "flex flex-col gap-2 border-0 bg-muted/50",
            className
          )}
          {...props}
        />
      </div>
    </ConfirmationContext.Provider>
  );
};

export type ConfirmationTitleProps = ComponentProps<typeof AlertDescription>;

export const ConfirmationTitle = ({
  className,
  ...props
}: ConfirmationTitleProps) => (
  <AlertDescription className={cn("inline", className)} {...props} />
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
    <div
      className={cn("flex items-center justify-end gap-2 self-end", className)}
      {...props}
    />
  );
};

export type ConfirmationActionTone = "allow" | "reject" | "neutral";

export type ConfirmationActionProps = ComponentProps<typeof Button> & {
  tone?: ConfirmationActionTone;
};

export const ConfirmationAction = ({
  className,
  tone = "neutral",
  ...props
}: ConfirmationActionProps) => {
  const toneClassName =
    tone === "allow"
      ? "bg-emerald-600 text-white hover:bg-emerald-500 active:bg-emerald-700 focus-visible:ring-emerald-500/40 dark:bg-emerald-500 dark:hover:bg-emerald-400 dark:active:bg-emerald-600"
      : tone === "reject"
        ? "border-destructive/40 text-destructive hover:bg-destructive/10 active:bg-destructive/20 focus-visible:ring-destructive/30 dark:border-destructive/60 dark:text-destructive dark:hover:bg-destructive/20 dark:active:bg-destructive/30"
        : "";

  return (
    <Button
      className={cn(
        "h-8 px-3 text-sm transition-[transform,box-shadow,background-color,color] active:translate-y-px active:scale-[0.98] active:shadow-inner disabled:active:translate-y-0 disabled:active:scale-100",
        toneClassName,
        className
      )}
      type="button"
      {...props}
    />
  );
};
