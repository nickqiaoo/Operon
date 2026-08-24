import { createPortal } from 'react-dom';
import { FormattedMessage } from 'react-intl';
import { VscFolder } from 'react-icons/vsc';
import { cn } from '@/lib/utils';
import { getFileIcon } from '@/components/FileIcon';
import type { FileEntry } from '../hooks/useMentionSuggestions';
import { useEffect, useRef } from 'react';

interface MentionPopupProps {
  isOpen: boolean;
  suggestions: FileEntry[];
  selectedIndex: number;
  loading: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  getDisplayPath?: (entry: FileEntry) => string;
  onSelect: (entry: FileEntry) => void;
  onHover: (index: number) => void;
}

const getRightPathLabel = (displayPath: string, entryName: string) => {
  const normalizedPath = displayPath.replace(/\\/g, '/');
  const normalizedName = entryName.replace(/\\/g, '/');

  if (normalizedPath === normalizedName) return './';

  const suffix = `/${normalizedName}`;
  if (normalizedPath.endsWith(suffix)) {
    const parentPath = normalizedPath.slice(0, -suffix.length);
    return parentPath.length > 0 ? parentPath : './';
  }

  return normalizedPath;
};

export function MentionPopup({
  isOpen,
  suggestions,
  selectedIndex,
  loading,
  anchorRef,
  getDisplayPath,
  onSelect,
  onHover,
}: MentionPopupProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  // Scroll selected item into view
  useEffect(() => {
    const el = itemRefs.current.get(selectedIndex);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!isOpen || (!loading && suggestions.length === 0)) return null;

  const anchor = anchorRef.current;
  if (!anchor) return null;

  const rect = anchor.getBoundingClientRect();
  const bottom = window.innerHeight - rect.top + 4;
  const left = rect.left;

  return createPortal(
    <div
      ref={panelRef}
      data-testid="mention-popup"
      style={{ left, bottom, maxWidth: Math.min(400, window.innerWidth - left - 16) }}
      className={cn(
        'fixed z-50 origin-bottom transition-all duration-150 ease-out',
        isOpen ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-1 pointer-events-none'
      )}
    >
      <div className="min-w-[240px] rounded-xl border border-border/40 bg-background/95 p-1 shadow-float backdrop-blur-lg">
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          <FormattedMessage id="editor.mention.paths" defaultMessage="Paths" />
        </div>
        <div className="max-h-56 overflow-y-auto scrollbar-none">
          {loading && suggestions.length === 0 && (
            <div className="px-3 py-3 text-center text-xs text-muted-foreground"><FormattedMessage id="common.loading" defaultMessage="Loading…" /></div>
          )}
          {suggestions.map((entry, index) => {
            const displayPath = getDisplayPath ? getDisplayPath(entry) : entry.path;
            const rightPathLabel = getRightPathLabel(displayPath, entry.name);
            return (
              <button
                key={entry.path}
                ref={(el) => {
                  if (el) itemRefs.current.set(index, el);
                  else itemRefs.current.delete(index);
                }}
                data-testid="mention-option"
                data-mention-path={entry.path}
                onClick={() => onSelect(entry)}
                onMouseEnter={() => onHover(index)}
                className={cn(
                  'grid w-full grid-cols-[1rem_minmax(0,0.9fr)_minmax(0,1.1fr)] items-center gap-1.5 rounded-lg px-3 py-1.5 text-left text-sm transition-colors',
                  index === selectedIndex
                    ? 'bg-muted/80 text-foreground'
                    : 'hover:bg-muted/40 text-foreground/80'
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                  {entry.isDirectory ? (
                    <VscFolder className="size-4" />
                  ) : (
                    getFileIcon(entry.name, 'size-4')
                  )}
                </span>
                <span className="min-w-0 truncate leading-5">{entry.name}</span>
                <span className="min-w-0 truncate text-right text-[11px] leading-5 text-muted-foreground/70">{rightPathLabel}</span>
              </button>
            );
          })}
          {!loading && suggestions.length === 0 && (
            <div className="px-3 py-3 text-center text-xs text-muted-foreground"><FormattedMessage id="editor.mention.noMatches" defaultMessage="No matches" /></div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
