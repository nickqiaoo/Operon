import path from 'path'
import { ASSISTANT_TOOL_NAMES } from './tools.js'

/**
 * How a worker's tool calls read in its Activity. Pure string work, shared by the projector and
 * the approval cards.
 */

/** The assistant tool a call is to (`start_task`…), or undefined for any other tool. */
export function assistantToolName(toolName: string): string | undefined {
  // mcp__assistant__start_task (Claude, Codex), assistant_worker_finish_task (OpenCode), …
  const bare = toolName.replace(/^mcp__assistant(_\w+?)?__/, '').replace(/^assistant(_(worker|wrapup))?_/, '')
  return bare !== toolName && ASSISTANT_TOOL_NAMES.has(bare) ? bare : undefined
}

/** Whether a tool call is one of the assistant's own tools rather than real work. */
export function isAssistantTool(toolName: string): boolean {
  return assistantToolName(toolName) !== undefined
}

/** A tool's own name, without the `mcp__server__` (or OpenCode `server_`) prefix. */
export function bareToolName(toolName: string): string {
  return toolName.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? unwrapMcpCall(parsed as Record<string, unknown>) : { command: input }
    } catch {
      return { command: input }
    }
  }
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? unwrapMcpCall(input as Record<string, unknown>) : {}
}

/** Codex reports an MCP call's input as `{ server, tool, arguments }`; the arguments are what it says. */
function unwrapMcpCall(input: Record<string, unknown>): Record<string, unknown> {
  const args = input.arguments
  return typeof input.server === 'string' && typeof input.tool === 'string' && args !== null && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : input
}

/** The command a shell call runs, without the `/bin/zsh -lc "…"` Codex wraps it in. */
function unwrapShell(command: string): string {
  const match = /^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/.exec(command.trim())
  if (!match) return command.trim()
  // Codex quotes by concatenation (`"…"'…'`), so the two ends need not match: drop one of each.
  return match[1]!.trim().replace(/^["']/, '').replace(/["']$/, '').trim()
}

/**
 * The step name a worker's tool call shows as. Agents' built-in tools cannot be given an argument
 * of the assistant's, so it is read off what the call already says: Claude's `description`, else
 * the command, path, URL or query, else the tool's name (design.md §2 rule 7).
 */
export function stepLabel(toolName: string, input: unknown, cwd?: string): string {
  const args = inputRecord(input)
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (Array.isArray(value) && value.length && value.every((v) => typeof v === 'string')) return (value as string[]).join(' ')
    }
    return undefined
  }
  const name = bareToolName(toolName)
  const described = pick('description', 'intent', 'title')
  if (described) return clip(described)
  const own = assistantToolName(toolName)
  if (own) return clip(ownToolLabel(own, args))
  const command = pick('command', 'cmd')
  if (command) return clip(unwrapShell(command))
  const target = pick('file_path', 'filePath', 'path', 'url', 'pattern', 'query')
  if (target) {
    const shown = cwd && path.isAbsolute(target) && target.startsWith(cwd) ? path.relative(cwd, target) || '.' : target
    return clip(`${name}: ${shown}`)
  }
  return name
}

/** The main agent's own changes, when it left out the description it is asked for. */
function ownToolLabel(tool: string, args: Record<string, unknown>): string {
  const file = typeof args.file === 'string' ? args.file : ''
  switch (tool) {
    case 'profile_edit':
      return `${args.action === 'append' ? 'Add to' : 'Edit'} ${file}.md`
    case 'set_identity':
      return 'Update identity.md'
    case 'schedule_create':
      return typeof args.name === 'string' ? `Schedule: ${args.name}` : 'Add a schedule'
    case 'schedule_update':
      return 'Change a schedule'
    case 'schedule_delete':
      return 'Delete a schedule'
    default:
      return tool
  }
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 120 ? `${line.slice(0, 117)}…` : line
}
