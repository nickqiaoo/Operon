import { useMemo } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { PatchDiff } from '@pierre/diffs/react';
import { createTwoFilesPatch } from 'diff';
import { useThemeStore } from '@/stores/theme-store';
import { useIsMobile } from '@/hooks/useIsMobile';
import { createPierreDiffOptions, ensureTrailingNewline } from '@shared/tool-rendering/diff';

interface FileDiffViewerProps {
  filePath: string;
  oldContent: string;
  newContent: string;
  className?: string;
}

/**
 * Component to display file diffs for Edit and Write operations
 * Uses @pierre/diffs library for clean, syntax-highlighted diff display
 */
export function FileDiffViewer({
  filePath,
  oldContent,
  newContent,
  className,
}: FileDiffViewerProps) {
  const intl = useIntl();
  const isMobile = useIsMobile();
  const theme = useThemeStore((s) => s.theme);
  const themeType = useMemo(() => {
    if (theme === 'system') return 'system' as const;
    return theme === 'dark' ? ('dark' as const) : ('light' as const);
  }, [theme]);
  const patch = useMemo(() => {
    return createTwoFilesPatch(
      filePath,
      filePath,
      ensureTrailingNewline(oldContent),
      ensureTrailingNewline(newContent),
      intl.formatMessage({ id: 'editor.diff.before', defaultMessage: 'Before' }),
      intl.formatMessage({ id: 'editor.diff.after', defaultMessage: 'After' })
    );
  }, [filePath, oldContent, newContent, intl]);

  // Determine if this is a new file (empty old content) or an edit
  const isNewFile = !oldContent || oldContent.trim().length === 0;

  // Side-by-side splits the available width into two code columns. That is fine
  // on a desktop pane and unreadable on a phone, where each column ends up a few
  // characters wide and every line wraps. Stacking the versions keeps the full
  // width for one column. `useIsMobile` tracks the viewport, so a desktop window
  // dragged narrow gets the same treatment.
  const diffStyle = isNewFile || isMobile ? 'unified' : 'split';

  if (!patch || patch.length === 0) {
    return (
      <div className="rounded-lg border border-border/40 bg-muted/30 p-4 text-sm text-muted-foreground">
        <FormattedMessage id="editor.diff.cannotGenerate" defaultMessage="Unable to generate diff preview" />
      </div>
    );
  }

  return (
    <div className={className}>
      <PatchDiff
        patch={patch}
        className="pierre-diff-file-view rounded-lg overflow-hidden text-sm"
        options={createPierreDiffOptions(themeType, diffStyle)}
      />
    </div>
  );
}

/**
 * Helper component for Edit tool - shows old_string -> new_string diff
 */
interface EditDiffViewerProps {
  filePath: string;
  oldString: string;
  newString: string;
  className?: string;
}

export function EditDiffViewer({
  filePath,
  oldString,
  newString,
  className,
}: EditDiffViewerProps) {
  return (
    <FileDiffViewer
      filePath={filePath}
      oldContent={oldString}
      newContent={newString}
      className={className}
    />
  );
}

/**
 * Helper component for Write tool - shows file creation or full replacement
 */
interface WriteDiffViewerProps {
  filePath: string;
  oldContent?: string;
  newContent: string;
  className?: string;
}

export function WriteDiffViewer({
  filePath,
  oldContent = '',
  newContent,
  className,
}: WriteDiffViewerProps) {
  return (
    <FileDiffViewer
      filePath={filePath}
      oldContent={oldContent}
      newContent={newContent}
      className={className}
    />
  );
}
