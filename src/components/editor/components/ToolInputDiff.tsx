import { useIntl } from 'react-intl';
import { EditDiffViewer, WriteDiffViewer } from './FileDiffViewer';
import { DiffPreview } from '@/components/editor/DiffPreview';
import { CodeBlock } from '@/components/ai-elements/code-block';
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

/**
 * Specialized renderer for tool inputs that shows diff view for Edit and Write tools
 * Falls back to standard JSON display for other tools
 */
export function ToolInputDiff({ toolName, input, className }: ToolInputDiffProps) {
  const intl = useIntl()
  const lowerToolName = toolName.toLowerCase();

  // Check if this is an Edit tool (including Gemini's replace, OpenCode's edit)
  if (lowerToolName === 'edit' || lowerToolName === 'tool-edit' || lowerToolName === 'replace') {
    const editInput = normalizeEditInput(input);

    if (editInput.file_path && editInput.old_string && editInput.new_string) {
      return (
        <div className={cn('space-y-2 overflow-hidden p-4', className)}>
          <div className="flex items-center justify-between">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              {intl.formatMessage({ id: "editor.toolInput.editFile", defaultMessage: "Edit File" })}
            </h4>
            {editInput.replace_all && (
              <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                {intl.formatMessage({ id: "editor.toolInput.replaceAll", defaultMessage: "Replace All" })}
              </span>
            )}
          </div>

          <div className="text-xs text-muted-foreground mb-2 font-mono">
            {editInput.file_path}
          </div>

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
  if (lowerToolName === 'write' || lowerToolName === 'tool-write' || lowerToolName === 'write_file') {
    const writeInput = normalizeWriteInput(input);

    if (writeInput.file_path && writeInput.content) {
      return (
        <div className={cn('space-y-2 overflow-hidden p-4', className)}>
          <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {intl.formatMessage({ id: "editor.toolInput.writeFile", defaultMessage: "Write File" })}
          </h4>

          <div className="text-xs text-muted-foreground mb-2 font-mono">
            {writeInput.file_path}
          </div>

          <WriteDiffViewer
            filePath={writeInput.file_path}
            oldContent=""
            newContent={writeInput.content}
          />

          <div className="text-xs text-muted-foreground pt-2">
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
        <div className={cn('space-y-3 overflow-hidden p-4', className)}>
          <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {intl.formatMessage({ id: "editor.toolInput.fileChanges", defaultMessage: "File Changes" })}
          </h4>
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

  // Fallback: Standard JSON display for other tools
  return (
    <div className={cn('space-y-2 overflow-hidden p-4', className)}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {intl.formatMessage({ id: "editor.toolInput.parameters", defaultMessage: "Parameters" })}
      </h4>
      <div className="rounded-xl bg-muted/50">
        <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
      </div>
    </div>
  );
}
