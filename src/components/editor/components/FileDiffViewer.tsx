import { useMemo } from 'react';
import { FileDiff, Virtualizer } from '@pierre/diffs/react';
import { DEFAULT_VIRTUAL_FILE_METRICS } from '@pierre/diffs';
import { useThemeStore } from '@/stores/theme-store';
import { useIsMobile } from '@/hooks/useIsMobile';
import { createPierreDiffOptions } from '@shared/tool-rendering/diff';
import { DiffWorkerProvider } from '@/components/diff/DiffWorkerProvider';
import { usePreparedDiff } from '@/components/diff/usePreparedDiff';
import { useFileOpenHandler } from '@/lib/file-open-context';
import { Button } from '@/components/ui/button';

interface FileDiffViewerProps {
  filePath: string;
  oldContent: string;
  newContent: string;
  className?: string;
}

export function FileDiffViewer({ filePath, oldContent, newContent, className }: FileDiffViewerProps) {
  const isMobile = useIsMobile();
  const openFile = useFileOpenHandler();
  const theme = useThemeStore((s) => s.theme);
  const result = usePreparedDiff(filePath, oldContent, newContent);
  const isNewFile = oldContent.length === 0;
  const diffStyle = isNewFile || isMobile ? 'unified' : 'split';
  const lineHeight = isMobile ? 20 : 18;
  const lineCount = result?.status === 'ready'
    ? (diffStyle === 'unified' ? result.fileDiff.unifiedLineCount : result.fileDiff.splitLineCount) : 0;
  const isLarge = lineCount > 150 || oldContent.length + newContent.length > 100_000;
  const options = useMemo(() => ({
    ...createPierreDiffOptions(theme, diffStyle, isLarge || isMobile ? 'scroll' : 'wrap'),
    disableFileHeader: true,
  }), [theme, diffStyle, isLarge, isMobile]);
  const metrics = useMemo(() => ({
    ...DEFAULT_VIRTUAL_FILE_METRICS, lineHeight, spacing: 4,
  }), [lineHeight]);

  if (!result) return <div className="py-3 text-xs text-muted-foreground">Preparing preview…</div>;
  if (result.status === 'limited') {
    // Never pass oversized/failed comparisons through the main-thread highlighter.
    const preview = (newContent || oldContent).slice(0, 16_000).split('\n').slice(0, 120).join('\n');
    return <div className={className}>
      <div className="flex items-center justify-between gap-3 py-2 text-xs text-muted-foreground">
        <span>Preview limited. Showing the beginning of the {newContent ? 'new' : 'previous'} content.</span>
        <Button variant="ghost" size="sm" onClick={() => openFile(filePath)} title="Open the current file on disk">Open file</Button>
      </div>
      <pre className="max-h-120 overflow-auto rounded-lg bg-muted/30 p-3 text-xs">{preview}</pre>
    </div>;
  }
  if (result.fileDiff.hunks.length === 0) {
    return <div className="py-3 text-xs text-muted-foreground">No changes.</div>;
  }

  const diff = <FileDiff fileDiff={result.fileDiff} options={options} metrics={metrics}
    className="pierre-diff-file-view rounded-lg overflow-hidden text-sm" />;
  return (
    <div className={className}>
      <DiffWorkerProvider>
        {isLarge ? (
          <Virtualizer className="pierre-hscroll h-120 overflow-auto rounded-lg" config={{ overscrollSize: 400 }}>
            {diff}
          </Virtualizer>
        ) : (
          <div className={isMobile ? 'pierre-hscroll rounded-lg' : undefined}>{diff}</div>
        )}
      </DiffWorkerProvider>
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
