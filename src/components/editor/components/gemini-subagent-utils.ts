import type { ToolPartLike } from './toolName';
import type { ToolInvocationPart } from './SubAgentRenderer';

// ── Types mirroring SubagentProgress from gemini-cli-core ───────────

interface SubagentActivityItem {
  id: string;
  type: 'thought' | 'tool_call';
  content: string;
  displayName?: string;
  description?: string;
  args?: string;
  output?: string;
  status: 'running' | 'completed' | 'error' | 'cancelled';
}

export interface SubagentProgressData {
  isSubagentProgress: true;
  agentName: string;
  state: 'running' | 'completed' | 'error' | 'cancelled';
  recentActivity: SubagentActivityItem[];
}

// ── Detection ───────────────────────────────────────────────────────

export function getSubagentProgress(
  toolPart: ToolPartLike & { result?: unknown; output?: unknown },
): SubagentProgressData | null {
  const output = toolPart.result ?? toolPart.output;
  if (output == null || typeof output !== 'object') return null;
  const obj = output as Record<string, unknown>;
  if (obj.isSubagentProgress !== true) return null;
  return obj as unknown as SubagentProgressData;
}

// ── Tool name mapping (Gemini CLI → CC equivalents) ─────────────────

const GEMINI_TOOL_NAME_MAP: Record<string, string> = {
  shell: 'Bash',
  run_shell_command: 'Bash',
  read_file: 'Read',
  edit_file: 'Edit',
  write_file: 'Write',
  write_new_file: 'Write',
  search_files: 'Grep',
  grep: 'Grep',
  list_dir: 'Glob',
  find_files: 'Glob',
  glob: 'Glob',
  web_search: 'WebSearch',
  google_web_search: 'WebSearch',
};

// ── Status mapping ──────────────────────────────────────────────────

export function mapSubagentState(status: string): string {
  return mapActivityStatus(status);
}

function mapActivityStatus(status: string): string {
  switch (status) {
    case 'running':
      return 'input-streaming';
    case 'completed':
      return 'output-available';
    case 'error':
      return 'output-error';
    case 'cancelled':
      return 'output-denied';
    default:
      return 'input-available';
  }
}

// ── Conversion ──────────────────────────────────────────────────────

export function convertSubagentToChildParts(
  activities: SubagentActivityItem[],
): ToolInvocationPart[] {
  return activities
    .filter((a) => a.type === 'tool_call')
    .map((a) => {
      const mappedName =
        GEMINI_TOOL_NAME_MAP[a.content] ?? a.displayName ?? a.content;

      let parsedArgs: Record<string, unknown> = {};
      try {
        if (a.args) parsedArgs = JSON.parse(a.args);
      } catch {
        // ignore parse errors
      }

      // Normalize: Gemini uses `path`, CC uses `file_path`
      if (parsedArgs.path && !parsedArgs.file_path) {
        parsedArgs.file_path = parsedArgs.path;
      }
      // Add description from activity metadata for Bash label
      if (a.description && !parsedArgs.description) {
        parsedArgs.description = a.description;
      }

      return {
        toolName: mappedName,
        toolCallId: a.id,
        args: parsedArgs,
        state: mapActivityStatus(a.status),
        ...(a.output ? { result: { output: a.output } } : {}),
      } as ToolInvocationPart;
    });
}
