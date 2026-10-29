"use client";

import {
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import type { ChatStatus } from "ai";
import {
  CornerDownLeftIcon,
  Loader2Icon,
  SquareIcon,
} from "lucide-react";
import {
  type ChangeEvent,
  Children,
  type ClipboardEventHandler,
  type ComponentProps,
  type HTMLAttributes,
  type KeyboardEventHandler,
  useRef,
} from "react";
import {
  useOptionalPromptInputController,
  usePromptInputAttachments,
  usePromptInputSubmitting,
} from "./prompt-input-context";

// ============================================================================
// Body
// ============================================================================

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputBody = ({
  className,
  ...props
}: PromptInputBodyProps) => (
  <div className={cn("contents", className)} {...props} />
);

// ============================================================================
// Textarea
// ============================================================================

export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea>;

export const PromptInputTextarea = ({
  onChange,
  onKeyDown,
  className,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputTextareaProps) => {
  const controller = useOptionalPromptInputController();
  const attachments = usePromptInputAttachments();
  // Use a ref instead of state for IME composition tracking.
  // In some browsers/IMEs, compositionend fires BEFORE the keydown event,
  // so a state-based flag would already be false when the Enter keydown arrives.
  // By delaying the ref reset with setTimeout, we ensure the "confirm composition"
  // Enter keydown is still caught.
  const composingRef = useRef(false);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    // Apply the delayed IME guard to the caller's Enter action as well.
    if (e.key === "Enter" && (composingRef.current || e.nativeEvent.isComposing)) return;
    onKeyDown?.(e);
    if (e.defaultPrevented) return;

    if (e.key === "Enter") {
      if (composingRef.current || e.nativeEvent.isComposing) return;
      if (e.shiftKey) return;
      e.preventDefault();

      const form = e.currentTarget.form;
      const submitButton = form?.querySelector(
        'button[type="submit"]'
      ) as HTMLButtonElement | null;
      if (submitButton?.disabled) return;

      form?.requestSubmit();
    }

    if (
      e.key === "Backspace" &&
      e.currentTarget.value === "" &&
      attachments.files.length > 0
    ) {
      e.preventDefault();
      const lastAttachment = attachments.files.at(-1);
      if (lastAttachment) attachments.remove(lastAttachment.id);
    }
  };

  const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = (event) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    if (files.length > 0) {
      event.preventDefault();
      attachments.add(files);
    }
  };

  const controlledProps = controller
    ? {
        value: controller.textInput.value,
        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
          controller.textInput.setInput(e.currentTarget.value);
          onChange?.(e);
        },
      }
    : { onChange };

  return (
    <InputGroupTextarea
      className={cn("field-sizing-content max-h-48 min-h-16", className)}
      name="message"
      onCompositionEnd={() => {
        // Delay reset so the Enter keydown that follows compositionend
        // in some browsers still sees composingRef as true.
        setTimeout(() => { composingRef.current = false; }, 0);
      }}
      onCompositionStart={() => { composingRef.current = true; }}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder={placeholder}
      {...props}
      {...controlledProps}
    />
  );
};

// ============================================================================
// Header / Footer / Tools
// ============================================================================

export type PromptInputFooterProps = Omit<ComponentProps<typeof InputGroupAddon>, "align">;

export const PromptInputFooter = ({ className, ...props }: PromptInputFooterProps) => (
  <InputGroupAddon align="block-end" className={cn("justify-between gap-1", className)} {...props} />
);

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({ className, ...props }: PromptInputToolsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props} />
);

// ============================================================================
// Button
// ============================================================================

export type PromptInputButtonProps = ComponentProps<typeof InputGroupButton>;

export const PromptInputButton = ({
  variant = "ghost",
  className,
  size,
  ...props
}: PromptInputButtonProps) => {
  const newSize = size ?? (Children.count(props.children) > 1 ? "sm" : "icon-sm");

  return (
    <InputGroupButton
      className={cn(className)}
      size={newSize}
      type="button"
      variant={variant}
      {...props}
    />
  );
};

// ============================================================================
// Action Menu
// ============================================================================

// ============================================================================
// Submit
// ============================================================================

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: ChatStatus;
  onStop?: () => void;
};

export const PromptInputSubmit = ({
  className,
  variant = "default",
  size = "icon-sm",
  status,
  onStop,
  onClick,
  children,
  disabled,
  ...props
}: PromptInputSubmitProps) => {
  const isGenerating = status === "submitted" || status === "streaming";
  // Attachments upload before the turn starts, so there is a window where the
  // send is underway but `status` is still idle. Block re-clicks over it —
  // except once generating, where the button becomes Stop and must stay live.
  const submitting = usePromptInputSubmitting() && !isGenerating;

  let Icon = <CornerDownLeftIcon className="size-4" />;
  if (status === "submitted" || status === "streaming") {
    Icon = <SquareIcon className="size-4" />;
  } else if (submitting) {
    Icon = <Loader2Icon className="size-4 animate-spin" />;
  }

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isGenerating && onStop) {
      e.preventDefault();
      onStop();
      return;
    }
    onClick?.(e);
  };

  return (
    <InputGroupButton
      aria-label={isGenerating ? "Stop" : "Submit"}
      className={cn(className)}
      disabled={disabled || submitting}
      onClick={handleClick}
      size={size}
      type={isGenerating && onStop ? "button" : "submit"}
      variant={variant}
      {...props}
    >
      {children ?? Icon}
    </InputGroupButton>
  );
};

// ============================================================================
// Select
// ============================================================================

// ============================================================================
// HoverCard
// ============================================================================

// ============================================================================
// Tabs
// ============================================================================

// ============================================================================
// Command
// ============================================================================
