import path from 'path'
import { ASSISTANT_TOOL_NAMES } from './tools.js'

/**
 * How a worker's tool calls read in its Activity. Pure string work, shared by the projector and
 * the approval cards.
 */

/** Whether a tool call is one of the assistant's own tools rather than real work. */
export function isAssistantTool(toolName: string): boolean {
  // mcp__assistant__start_task (Claude, Codex), assistant_worker_finish_task (OpenCode), …
  const bare = toolName.replace(/^mcp__assistant(_\w+?)?__/, '').replace(/^assistant(_(worker|wrapup))?_/, '')
  return bare !== toolName && ASSISTANT_TOOL_NAMES.has(bare)
}

/** A tool's own name, without the `mcp__server__` (or OpenCode `server_`) prefix. */
export function bareToolName(toolName: string): string {
  return toolName.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { command: input }
    } catch {
      return { command: input }
    }
  }
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
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
  const command = pick('command', 'cmd')
  if (command) return clip(unwrapShell(command))
  const target = pick('file_path', 'filePath', 'path', 'url', 'pattern', 'query')
  if (target) {
    const shown = cwd && path.isAbsolute(target) && target.startsWith(cwd) ? path.relative(cwd, target) || '.' : target
    return clip(`${name}: ${shown}`)
  }
  return name
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 120 ? `${line.slice(0, 117)}…` : line
}
