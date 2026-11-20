import { useIntl } from 'react-intl';
import { useMemo } from 'react';
import { countContentLines } from '@/components/diff/prepare-diff';
import { usePreparedDiff } from '@/components/diff/usePreparedDiff';
import { EditDiffViewer, FileDiffViewer, WriteDiffViewer } from './FileDiffViewer';
import { DiffPreview } from '@/components/editor/DiffPreview';
import { ToolInput } from '@/components/ai-elements/tool';
import { cn } from '@/lib/utils';

interface FileChange {
  path: string;
  kind?: { type: string };
  type?: string;
  diff?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function hasPatchChanges(value: unknown): value is Record<string, unknown> & { changes: FileChange[] } {
  if (!isRecord(value) || !Array.isArray(value.changes) || !value.changes.length) return false;
  return value.changes.every((change: unknown) =>
    isRecord(change) && typeof change.path === 'string' &&
    (change.diff === undefined || typeof change.diff === 'string') &&
    (change.type === undefined || typeof change.type === 'string') &&
    (change.kind === undefined || (isRecord(change.kind) && typeof change.kind.type === 'string')),
  );
}

function PatchFilePreview({ change }: { change: FileChange }) {
  const { path, diff } = change;
  const kind = change.kind?.type;
  // Codex sends the file body for add/delete, and unified hunks for update.
  if (diff && kind !== 'add' && kind !== 'delete') {
    return <DiffPreview path={path} content={diff} />;
  }

  const lines = diff ? countContentLines(diff) : 0;
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
        <span className="capitalize">{kind ?? change.type}</span>
        <span className="truncate" title={path}>{path}</span>
        {lines > 0 && (kind === 'add'
          ? <span className="text-diff-add">+{lines}</span>
          : <span className="text-diff-remove">-{lines}</span>)}
      </div>
      {diff && <FileDiffViewer
        filePath={path}
        oldContent={kind === 'delete' ? diff : ''}
        newContent={kind === 'add' ? diff : ''}
      />}
    </div>
  );
}

interface FileEditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface FileWriteInput {
  file_path: string;
  content: string;
}

interface ToolInputDiffProps {
  toolName: string;
  input: Record<string, unknown>;
  className?: string;
}

/** Normalize input fields to snake_case (handles camelCase from OpenCode etc.) */
function normalizeEditInput(input: Record<string, unknown>): Partial<FileEditInput> {
  return {
    file_path: (input.file_path ?? input.filePath) as string | undefined,
    old_string: (input.old_string ?? input.oldString) as string | undefined,
    new_string: (input.new_string ?? input.newString) as string | undefined,
    replace_all: (input.replace_all ?? input.replaceAll) as boolean | undefined,
  };
}

function normalizeWriteInput(input: Record<string, unknown>): Partial<FileWriteInput> {
  return {
    file_path: (input.file_path ?? input.filePath) as string | undefined,
    content: input.content as string | undefined,
  };
}

function isEditTool(lowerToolName: string) {
  return lowerToolName === 'edit' || lowerToolName === 'tool-edit' || lowerToolName === 'replace';
}

function isWriteTool(lowerToolName: string) {
  return lowerToolName === 'write' || lowerToolName === 'tool-write' || lowerToolName === 'write_file';
}

/** Share the comparison with the expanded preview; Write only needs a line count. */
export function useToolInputDiffStats(toolName: string, input: Record<string, unknown>, enabled = true) {
  const lowerToolName = toolName.toLowerCase();
  const edit = normalizeEditInput(input);
  const isEdit = isEditTool(lowerToolName);
  const result = usePreparedDiff(edit.file_path ?? '', edit.old_string ?? '', edit.new_string ?? '',
    enabled && isEdit && typeof edit.old_string === 'string' && typeof edit.new_string === 'string');
  const content = isWriteTool(lowerToolName) ? normalizeWriteInput(input).content : undefined;
  const writeStats = useMemo(() => typeof content === 'string'
    ? { additions: countContentLines(content), deletions: 0 } : null, [content]);
  return isEdit ? (result?.status === 'ready' ? result.stats : null) : writeStats;
}

/**
 * Specialized renderer for tool inputs that shows diff view for Edit and Write tools.
 * Falls back to the generic ToolInput for other tools. It sits inside a Tool
 * line's content, and that line already names the file, so there is no header.
 */
export function ToolInputDiff({ toolName, input, className }: ToolInputDiffProps) {
  const intl = useIntl()
  const lowerToolName = toolName.toLowerCase();

  // Check if this is an Edit tool (including Gemini's replace, OpenCode's edit)
  if (isEditTool(lowerToolName)) {
    const editInput = normalizeEditInput(input);

    if (editInput.file_path && typeof editInput.old_string === 'string' && typeof editInput.new_string === 'string') {
      return (
        <div className={cn('space-y-2 overflow-hidden', className)}>
          {editInput.replace_all && (
            <span className="text-xs text-status-warn font-medium">
              {intl.formatMessage({ id: "editor.toolInput.replaceAll", defaultMessage: "Replace All" })}
            </span>
          )}
          <EditDiffViewer
            filePath={editInput.file_path}
            oldString={editInput.old_string}
            newString={editInput.new_string}
          />
        </div>
      );
    }
  }

  // Check if this is a Write tool (including Gemini's write_file, OpenCode's write)
  if (isWriteTool(lowerToolName)) {
    const writeInput = normalizeWriteInput(input);

    if (writeInput.file_path && writeInput.content) {
      return (
        <div className={cn('space-y-2 overflow-hidden', className)}>
          <WriteDiffViewer
            filePath={writeInput.file_path}
            oldContent=""
            newContent={writeInput.content}
          />

          <div className="text-xs text-muted-foreground">
            {intl.formatMessage({ id: "editor.toolInput.linesChars", defaultMessage: "{lines} lines • {chars} characters" }, { lines: countContentLines(writeInput.content), chars: writeInput.content.length })}
          </div>
        </div>
      );
    }
  }

  // Check if this is a Codex patch tool (file change with changes array)
  if (lowerToolName === 'patch' && hasPatchChanges(input)) {
    return (
      <div className={cn('space-y-3 overflow-hidden', className)}>
        {input.changes.map((change, i) => <PatchFilePreview key={i} change={change} />)}
      </div>
    );
  }

  return <ToolInput input={input} className={className} />;
}
