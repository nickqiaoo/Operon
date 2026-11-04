import { useEffect, useState } from 'react';
import { BrainIcon } from 'lucide-react';

import { PromptInputButton } from '@/components/ai-elements/prompt-input';
import { MobileSheet } from '@/components/mobile/MobileSheet';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { useIsMobile } from '@/hooks/useIsMobile';
import { cn } from '@/lib/utils';

interface EffortOption {
  value: string;
  label: string;
}

interface ThinkingEffortPickerProps {
  options: EffortOption[];
  value: string;
  onChange: (value: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  buttonClassName?: string;
}

// The thumb is as tall as the 28px track. Radix keeps it in bounds, so its
// centre travels from 14px to (100% - 14px) — not along the raw percentage that
// Radix's own Range uses. The fill and the step marks follow the thumb's path so
// the fill always ends under the thumb's centre.
const THUMB_HALF = 14;
const alongThumbPath = (fraction: number) =>
  `calc(${THUMB_HALF}px + (100% - ${THUMB_HALF * 2}px) * ${fraction})`;

/**
 * Thinking level as an ordered scale: the composer pill opens a slider with
 * one stop per level, the way Codex picks reasoning effort. The level is
 * applied on release (drag) or per key press, not on every intermediate step.
 */
export function ThinkingEffortPicker({
  options,
  value,
  onChange,
  open,
  onOpenChange,
  disabled,
  buttonClassName,
}: ThinkingEffortPickerProps) {
  const isMobile = useIsMobile();
  const committedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  // While dragging, show the level under the thumb before it is committed.
  const [draftIndex, setDraftIndex] = useState(committedIndex);
  useEffect(() => setDraftIndex(committedIndex), [committedIndex]);

  const label = options[committedIndex]?.label ?? value;
  const draftLabel = options[draftIndex]?.label ?? label;
  const last = options.length - 1;

  const trigger = (
    <PromptInputButton
      data-composer-dismiss-keyboard
      data-testid="chat-thinking-toggle"
      aria-label={`Thinking level: ${label}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={`Thinking level: ${label}`}
      disabled={disabled}
      onClick={isMobile ? () => onOpenChange(!open) : undefined}
      className={buttonClassName}
    >
      <BrainIcon className="size-3.5" />
      <span>{label}</span>
    </PromptInputButton>
  );

  const body = (
    <div className="flex flex-col gap-2.5" data-composer-dismiss-keyboard>
      <span data-testid="chat-thinking-level" className="text-center text-sm font-semibold text-brand">{draftLabel}</span>
      <Slider
        aria-label="Thinking level"
        min={0}
        max={Math.max(last, 1)}
        step={1}
        value={[draftIndex]}
        disabled={options.length < 2}
        onValueChange={([index]) => setDraftIndex(index)}
        onValueCommit={([index]) => {
          const next = options[index];
          if (next && next.value !== value) onChange(next.value);
        }}
        trackClassName="data-[orientation=horizontal]:h-7"
        rangeClassName="hidden"
        thumbClassName="size-7 ring-border/50 hover:ring-2 focus-visible:ring-2"
        overlay={
          <span aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
            <span
              className="absolute inset-y-0 left-0 bg-brand-fill"
              style={{ width: alongThumbPath(last > 0 ? draftIndex / last : 0) }}
            />
            {options.map((option, index) => (
              <span
                key={option.value}
                className={cn(
                  'absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full',
                  index < draftIndex ? 'bg-white/70' : 'bg-foreground/25'
                )}
                style={{
                  left: last > 0 ? alongThumbPath(index / last) : '50%',
                }}
              />
            ))}
          </span>
        }
      />
      {options.length > 1 && (
        <div className="flex justify-between px-1 text-xs text-muted-foreground">
          <span>{options[0].label}</span>
          <span>{options[last].label}</span>
        </div>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        <MobileSheet open={open} onClose={() => onOpenChange(false)} title="Thinking level" bodyClassName="px-4 pb-6 pt-1">
          {body}
        </MobileSheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        aria-label="Thinking level"
        // Returning focus to the pill paints its focus ring after a mouse pick.
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-64 max-w-[calc(100vw-1rem)] p-3"
      >
        {body}
      </PopoverContent>
    </Popover>
  );
}
