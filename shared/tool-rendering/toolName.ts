export type ToolPartLike = {
  type?: string
  toolName?: string
  name?: string
  args?: Record<string, unknown>
  input?: Record<string, unknown>
}

const TOOL_DESCRIPTION_FIELDS: Record<string, string[]> = {
  bash: ['command', 'cmd'],
  exec: ['command', 'cmd'],
  run_shell_command: ['command', 'cmd'],
  shell: ['command', 'cmd'],

  read: ['file_path', 'filePath', 'path'],
  cat: ['file_path', 'filePath', 'path'],
  read_file: ['file_path', 'filePath', 'path'],

  write: ['file_path', 'filePath', 'path'],
  edit: ['file_path', 'filePath', 'path'],
  replace: ['file_path', 'filePath', 'path'],
  write_file: ['file_path', 'filePath', 'path'],
  patch: ['file_path', 'filePath', 'path'],
  notebookedit: ['notebook_path', 'notebookPath'],

  grep: ['pattern', 'query'],
  search: ['pattern', 'query'],
  ripgrep: ['pattern', 'query'],
  glob: ['pattern', 'query'],
  find: ['pattern', 'query', 'path'],
  list_files: ['pattern', 'query', 'path'],

  websearch: ['query'],
  web_search: ['query'],
  google_search: ['query'],
  webfetch: ['url'],
  web_fetch: ['url'],
  fetch: ['url'],

  agent: ['description', 'subagent_type'],
  external_agent_run: ['description', 'agent_type'],
  mcp__external_agent__external_agent_run: ['description', 'agent_type'],
}

const FALLBACK_FIELDS = [
  'command',
  'cmd',
  'file_path',
  'filePath',
  'path',
  'pattern',
  'query',
  'url',
  'description',
  'notebook_path',
  'notebookPath',
  'skill',
]

export const normalizeToolName = (name: string): string => {
  const withoutPrefix = name.startsWith('tool-') ? name.slice(5) : name
  return withoutPrefix.replace(/[`\s]/g, '').toLowerCase()
}

export const displayToolName = (name: string): string => {
  const withoutPrefix = name.startsWith('tool-') ? name.slice(5) : name
  return withoutPrefix.replace(/`/g, '').trim() || 'Tool'
}

export const readString = (
  obj: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

export const readNumber = (
  obj: Record<string, unknown>,
  keys: readonly string[],
): number | undefined => {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/** Params shown in the collapsed summary when no well-known field matched. */
const SUMMARY_MAX_FIELDS = 2
const SUMMARY_MAX_VALUE_LENGTH = 32

/**
 * `key=value · key=value` preview of the first scalar args. MCP tools rarely
 * use any of the well-known field names, which used to leave their collapsed
 * row with no summary at all.
 */
const summarizeScalarArgs = (args: Record<string, unknown>): string | undefined => {
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (parts.length >= SUMMARY_MAX_FIELDS) break
    if (value === null || value === undefined || typeof value === 'object') continue
    const raw = String(value).replace(/\s+/g, ' ').trim()
    if (!raw) continue
    const clipped =
      raw.length > SUMMARY_MAX_VALUE_LENGTH ? `${raw.slice(0, SUMMARY_MAX_VALUE_LENGTH)}…` : raw
    parts.push(`${key}=${clipped}`)
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export const getToolDescription = (
  toolName: string,
  args: Record<string, unknown>,
): string | undefined => {
  const normalized = normalizeToolName(toolName)
  const fields = TOOL_DESCRIPTION_FIELDS[normalized] ?? FALLBACK_FIELDS
  return readString(args, fields) ?? summarizeScalarArgs(args)
}

/**
 * Some providers route every call through one generic tool and put the real
 * target inside the arguments — grok over ACP emits
 * `use_tool { tool_name: 'node_repl__js', tool_input: {...} }`. Rendering that
 * verbatim shows the envelope instead of the call, and hides the real arguments
 * one level down where they read as a nested blob of JSON.
 *
 * Returns the unwrapped name/input, or the originals when this isn't an envelope.
 */
export const unwrapToolEnvelope = (
  toolName: string,
  input: Record<string, unknown>,
): { toolName: string; input: Record<string, unknown> } => {
  const innerName = input.tool_name ?? input.toolName
  const innerInput = input.tool_input ?? input.toolInput
  if (
    typeof innerName !== 'string' ||
    !innerName ||
    typeof innerInput !== 'object' ||
    innerInput === null ||
    Array.isArray(innerInput)
  ) {
    return { toolName, input }
  }
  return { toolName: innerName, input: innerInput as Record<string, unknown> }
}

/**
 * Presentation-only label. `getToolDisplayName` feeds identity checks across the
 * renderers (`=== 'Workflow'`, `EXIT_PLAN_NAMES.has(...)`, diff-view detection),
 * so its value must stay byte-stable — this wraps it purely for display.
 */
export const formatToolDisplayName = (name: string): string => {
  const clean = displayToolName(name)
  // mcp__github__create_issue → github · create_issue
  const mcp = clean.match(/^mcp__(.+?)__(.+)$/)
  return mcp ? `${mcp[1]} · ${mcp[2]}` : clean
}

export const getToolDisplayName = (toolPart: ToolPartLike): string => {
  const rawInput = toolPart.args ?? toolPart.input ?? {}
  const inputToolName = typeof rawInput.toolName === 'string' ? rawInput.toolName : undefined
  const typeName = typeof toolPart.type === 'string' ? toolPart.type : undefined
  const fromType = typeName?.startsWith('tool-') ? typeName.slice(5) : typeName

  return (
    (typeof toolPart.toolName === 'string' && toolPart.toolName) ||
    (typeof toolPart.name === 'string' && toolPart.name) ||
    inputToolName ||
    fromType ||
    'Unknown Tool'
  )
}
