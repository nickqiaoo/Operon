import { useState, type ReactNode } from 'react';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';

import { PromptInputButton } from '@/components/ai-elements/prompt-input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MobileSheet } from '@/components/mobile/MobileSheet';
import { useIsMobile } from '@/hooks/useIsMobile';
import { cn } from '@/lib/utils';

export interface ComposerOption {
  value: string;
  label: string;
  description?: string;
  /** Leading glyph in the list (colour dot, level bars…). */
  icon?: ReactNode;
}

interface ComposerOptionPickerProps {
  /** Heading shown above the list (menu label / sheet title). */
  title: string;
  options: ComposerOption[];
  value: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
  buttonClassName?: string;
  /** Content of the trigger button (icon + current label). */
  children: ReactNode;
  'data-testid'?: string;
  'aria-label'?: string;
  tooltip?: string;
  /** Controlled open state, so sibling pickers can close each other. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Composer footer pill that opens a list of options above it — used for the
 * thinking level and the permission mode. One click opens, one click picks,
 * instead of cycling through every value to reach the one you want.
 */
export function ComposerOptionPicker({
  title,
  options,
  value,
  onSelect,
  disabled,
  buttonClassName,
  children,
  tooltip,
  'data-testid': testId,
  'aria-label': ariaLabel,
  open: openProp,
  onOpenChange,
}: ComposerOptionPickerProps) {
  const isMobile = useIsMobile();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };

  const trigger = (
    <PromptInputButton
      data-composer-dismiss-keyboard
      data-testid={testId}
      aria-label={ariaLabel ?? title}
      aria-haspopup="menu"
      aria-expanded={open}
      title={tooltip}
      disabled={disabled}
      onClick={isMobile ? () => setOpen(!open) : undefined}
      className={buttonClassName}
    >
      {children}
      <ChevronDownIcon className={cn('size-3 opacity-50 transition-transform @max-[420px]:hidden', open && 'rotate-180')} />
    </PromptInputButton>
  );

  const renderRow = (option: ComposerOption) => (
    <>
      {option.icon && <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center self-start">{option.icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{option.label}</span>
        {option.description && (
          <span className="line-clamp-2 text-xs text-muted-foreground">{option.description}</span>
        )}
      </span>
      <CheckIcon className={cn('mt-0.5 size-3.5 shrink-0 self-start text-tint', option.value !== value && 'invisible')} />
    </>
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        <MobileSheet open={open} onClose={() => setOpen(false)} title={title} bodyClassName="px-1 pb-3">
          <div role="menu" aria-label={title} data-composer-dismiss-keyboard className="flex flex-col">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={option.value === value}
                onClick={() => {
                  onSelect(option.value);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-row-hover"
              >
                {renderRow(option)}
              </button>
            ))}
          </div>
        </MobileSheet>
      </>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        // Returning focus to the pill paints its focus ring after a mouse pick.
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-60 max-w-[calc(100vw-1rem)]"
      >
        <DropdownMenuLabel className="px-2 py-1 text-xs font-medium text-muted-foreground">{title}</DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            role="menuitemradio"
            aria-checked={option.value === value}
            data-testid={testId ? `${testId}-option-${option.value}` : undefined}
            onSelect={() => onSelect(option.value)}
            className="items-start focus:bg-row-hover focus:text-foreground"
          >
            {renderRow(option)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
