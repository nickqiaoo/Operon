import { useIntl } from 'react-intl';
import { diffLines } from 'diff';
import { ensureTrailingNewline } from '@shared/tool-rendering/diff';
import { EditDiffViewer, WriteDiffViewer } from './FileDiffViewer';
import { DiffPreview } from '@/components/editor/DiffPreview';
import { ToolInput } from '@/components/ai-elements/tool';
import { cn } from '@/lib/utils';

interface FileChange {
  path: string;
  type: string;
  diff?: string;
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

function countLineChanges(oldText: string, newText: string) {
  let additions = 0;
  let deletions = 0;
  for (const change of diffLines(ensureTrailingNewline(oldText), ensureTrailingNewline(newText))) {
    if (change.added) additions += change.count ?? 0;
    else if (change.removed) deletions += change.count ?? 0;
  }
  return { additions, deletions };
}

/**
 * Line counts for an Edit / Write call, shown on its tool line. The diff below
 * has no file header (the line already names the file), so the counts move up.
 */
export function toolInputDiffStats(toolName: string, input: Record<string, unknown>) {
  const lowerToolName = toolName.toLowerCase();
  if (isEditTool(lowerToolName)) {
    const { old_string, new_string } = normalizeEditInput(input);
    return old_string && new_string ? countLineChanges(old_string, new_string) : null;
  }
  if (isWriteTool(lowerToolName)) {
    const { content } = normalizeWriteInput(input);
    return content ? countLineChanges('', content) : null;
  }
  return null;
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

    if (editInput.file_path && editInput.old_string && editInput.new_string) {
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
            {intl.formatMessage({ id: "editor.toolInput.linesChars", defaultMessage: "{lines} lines • {chars} characters" }, { lines: writeInput.content.split('\n').length, chars: writeInput.content.length })}
          </div>
        </div>
      );
    }
  }

  // Check if this is a Codex patch tool (file change with changes array)
  if (lowerToolName === 'patch') {
    const changes = input.changes as FileChange[] | undefined;
    if (Array.isArray(changes) && changes.length > 0) {
      const hasDiffs = changes.some((c) => c.diff);
      return (
        <div className={cn('space-y-3 overflow-hidden', className)}>
          {hasDiffs ? (
            <div className="space-y-4">
              {changes.map((change, i) => (
                <div key={i}>
                  {change.diff ? (
                    <DiffPreview path={change.path} content={change.diff} />
                  ) : (
                    <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
                      <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground capitalize">
                        {change.type}
                      </span>
                      {change.path}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <ul className="space-y-1">
              {changes.map((change, i) => (
                <li key={i} className="flex items-center gap-2 text-xs font-mono">
                  <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground capitalize">
                    {change.type}
                  </span>
                  <span className="text-muted-foreground">{change.path}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
  }

  return <ToolInput input={input} className={className} />;
}
