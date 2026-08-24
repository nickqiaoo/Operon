import { getToolDisplayName, type ToolPartLike } from '../toolName';

type Category = 'read' | 'write' | 'search' | 'command' | 'web' | 'task' | 'other';

const TOOL_CATEGORIES: Record<string, Category> = {
  read: 'read',
  cat: 'read',
  read_file: 'read',
  write: 'write',
  edit: 'write',
  replace: 'write',
  write_file: 'write',
  patch: 'write',
  notebookedit: 'write',
  grep: 'search',
  search: 'search',
  ripgrep: 'search',
  glob: 'search',
  find: 'search',
  list_files: 'search',
  bash: 'command',
  exec: 'command',
  run_shell_command: 'command',
  shell: 'command',
  websearch: 'web',
  web_search: 'web',
  google_search: 'web',
  webfetch: 'web',
  web_fetch: 'web',
  fetch: 'web',
  taskcreate: 'task',
  taskupdate: 'task',
  taskget: 'task',
  tasklist: 'task',
  todowrite: 'task',
  askuserquestion: 'task',
  ask_user: 'task',
};

const CATEGORY_LABELS: Record<Category, (count: number) => string> = {
  read: (n) => `Read ${n} file${n > 1 ? 's' : ''}`,
  write: (n) => `Edited ${n} file${n > 1 ? 's' : ''}`,
  search: (n) => `Searched ${n} pattern${n > 1 ? 's' : ''}`,
  command: (n) => `Ran ${n} command${n > 1 ? 's' : ''}`,
  web: (n) => `${n} Web request${n > 1 ? 's' : ''}`,
  task: (n) => `${n} Task operation${n > 1 ? 's' : ''}`,
  other: (n) => `${n} Tool call${n > 1 ? 's' : ''}`,
};

function categorize(toolName: string): Category {
  const lower = toolName.toLowerCase().replace(/[`\s]/g, '');
  return TOOL_CATEGORIES[lower] ?? 'other';
}

/**
 * Build a summary string for a group of tool calls.
 * e.g., "Read 3 files, searched 2 patterns, ran 1 command"
 */
export function buildToolGroupSummary(parts: ToolPartLike[]): string {
  const counts = new Map<Category, number>();

  for (const part of parts) {
    const name = getToolDisplayName(part);
    const category = categorize(name);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  // Ordered output: read, write, search, command, web, other
  const order: Category[] = ['read', 'write', 'search', 'command', 'web', 'task', 'other'];
  const segments: string[] = [];

  for (const cat of order) {
    const count = counts.get(cat);
    if (count) {
      segments.push(CATEGORY_LABELS[cat](count));
    }
  }

  return segments.join(', ') || `${parts.length} tool call${parts.length > 1 ? 's' : ''}`;
}
