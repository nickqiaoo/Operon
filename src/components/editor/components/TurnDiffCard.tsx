import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { ChevronDown, ChevronUp, SquarePen, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface TurnDiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

interface TurnDiffCardProps {
  files: TurnDiffFile[];
  onUndo?: () => void;
  onReview?: () => void;
  className?: string;
}

const INITIAL_VISIBLE = 3;

/**
 * Per-turn diff summary card (Codex-style): "Edited N files" with totals, a
 * collapsible per-file list, and Undo (rewind) + Review actions.
 */
export function TurnDiffCard({ files, onUndo, onReview, className }: TurnDiffCardProps) {
  const [expanded, setExpanded] = useState(false);

  if (files.length === 0) return null;

  const totalAdded = files.reduce((sum, f) => sum + f.additions, 0);
  const totalRemoved = files.reduce((sum, f) => sum + f.deletions, 0);
  const visible = expanded ? files : files.slice(0, INITIAL_VISIBLE);
  const hiddenCount = files.length - visible.length;

  return (
    <div className={cn('rounded-xl border border-border/60 bg-popover/90 shadow-input dark:border-border/35 dark:bg-popover/75', className)}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground">
            <SquarePen className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">
              <FormattedMessage id="editor.turnDiff.edited" defaultMessage="{count, plural, one {Edited # file} other {Edited # files}}" values={{ count: files.length }} />
            </div>
            <div className="text-xs">
              <span className="text-emerald-600 dark:text-emerald-400">+{totalAdded}</span>{' '}
              <span className="text-red-500 dark:text-red-400">-{totalRemoved}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {onUndo ? (
            <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={onUndo}>
              <Undo2 className="h-3.5 w-3.5" />
              <FormattedMessage id="editor.rewind.undo" defaultMessage="Undo" />
            </Button>
          ) : null}
          {onReview ? (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onReview}>
              <FormattedMessage id="tab.review.label" defaultMessage="Review" />
            </Button>
          ) : null}
        </div>
      </div>

      {/* File list */}
      <div className="border-t border-border/40">
        {visible.map((file) => (
          <div
            key={file.path}
            className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
          >
            <span className="truncate text-foreground/72" title={file.path}>
              {file.path}
            </span>
            <span className="shrink-0 text-xs tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{' '}
              <span className="text-red-500 dark:text-red-400">-{file.deletions}</span>
            </span>
          </div>
        ))}

        {files.length > INITIAL_VISIBLE ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-center gap-1.5 px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? (
              <>
                <ChevronUp className="h-3.5 w-3.5" />
                <FormattedMessage id="editor.turnDiff.showLess" defaultMessage="Show less" />
              </>
            ) : (
              <>
                <ChevronDown className="h-3.5 w-3.5" />
                <FormattedMessage id="editor.turnDiff.showMore" defaultMessage="Show {count, plural, one {# more file} other {# more files}}" values={{ count: hiddenCount }} />
              </>
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}
