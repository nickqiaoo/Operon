import { createPortal } from 'react-dom';
import { FormattedMessage, useIntl } from 'react-intl';
import { cn } from '@/lib/utils';
import type { SlashCommandItem } from '../hooks/useModelManagement';
import { useEffect, useRef } from 'react';

interface SlashCommandPopupProps {
  isOpen: boolean;
  suggestions: SlashCommandItem[];
  selectedIndex: number;
  loading: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onSelect: (item: SlashCommandItem) => void;
  onHover: (index: number) => void;
  onDismiss: () => void;
}

export function SlashCommandPopup({
  isOpen,
  suggestions,
  selectedIndex,
  loading,
  anchorRef,
  onSelect,
  onHover,
  onDismiss,
}: SlashCommandPopupProps) {
  const intl = useIntl();
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = itemRefs.current.get(selectedIndex);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popupRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onDismiss();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, anchorRef, onDismiss]);

  if (!isOpen || (!loading && suggestions.length === 0)) return null;

  const anchor = anchorRef.current;
  if (!anchor) return null;

  const rect = anchor.getBoundingClientRect();
  const bottom = window.innerHeight - rect.top + 4;
  const left = rect.left;

  return createPortal(
    <div
      ref={popupRef}
      data-testid="slash-command-menu"
      onMouseDown={(e) => e.preventDefault()}
      style={{ left, bottom, maxWidth: Math.min(320, window.innerWidth - left - 16) }}
      className={cn(
        'fixed z-50 origin-bottom transition-all duration-150 ease-out',
        isOpen ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-1 pointer-events-none'
      )}
    >
      <div className="min-w-[200px] rounded-xl border border-border/40 bg-background/95 p-1 shadow-float backdrop-blur-lg">
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          <FormattedMessage id="editor.slash.title" defaultMessage="Slash Commands" />
        </div>
        <div className="max-h-56 overflow-y-auto scrollbar-none">
          {loading && suggestions.length === 0 && (
            <div className="px-3 py-3 text-center text-xs text-muted-foreground"><FormattedMessage id="common.loading" defaultMessage="Loading…" /></div>
          )}
          {suggestions.map((item, index) => (
            <button
              key={item.name}
              ref={(el) => {
                if (el) itemRefs.current.set(index, el);
                else itemRefs.current.delete(index);
              }}
              data-testid={`slash-command-option-${item.name}`}
              onClick={() => onSelect(item)}
              onMouseEnter={() => onHover(index)}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm transition-colors',
                index === selectedIndex
                  ? 'bg-muted/80 text-foreground'
                  : 'hover:bg-muted/40 text-foreground/80'
              )}
            >
              <span className="min-w-0 truncate leading-5">{item.name}</span>
              <span className={cn(
                'ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                item.type === 'skill'
                  ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                  : 'bg-muted text-muted-foreground'
              )}>
                {item.type === 'skill'
                  ? intl.formatMessage({ id: 'editor.slash.typeSkill', defaultMessage: 'skill' })
                  : intl.formatMessage({ id: 'editor.slash.typeCommand', defaultMessage: 'command' })}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
