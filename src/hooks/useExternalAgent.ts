import type { UIMessage } from 'ai'

export interface ExternalAgentTask {
  taskId: string
  agentId?: string
  childChatId?: number
  agentType: string
  prompt: string
  description: string
  model?: string
  /**
   * Permission mode for the spawned tab, resolved server-side from the shared
   * sub-agent table. Nobody is watching a spawned tab, so it must not open in a
   * mode that stops to ask. Absent on results from an older server — the tab
   * then falls back to the picker's mode, as before.
   */
  mode?: string
}

/**
 * Parse an external agent run tool result from a message part.
 * Works for both MCP tool (`mcp__external_agent__external_agent_run`) and
 * Custom adapter tool (`external_agent_run`).
 */
export function parseExternalAgentRun(part: UIMessage['parts'][number]): ExternalAgentTask | null {
  // Only look at tool parts
  const partType = typeof part.type === 'string' ? part.type : ''
  if (partType !== 'dynamic-tool' && !partType.startsWith('tool-')) return null

  const toolPart = part as Record<string, unknown>
  const toolName = (toolPart.toolName ?? toolPart.name ?? '') as string

  // Match both MCP and direct tool names
  const isExternalAgentRun =
    toolName === 'external_agent_run' ||
    toolName === 'mcp__external_agent__external_agent_run' ||
    toolName.endsWith('external_agent_run') || toolName.endsWith('external_agent_send')

  if (!isExternalAgentRun) return null

  const rawOutput = toolPart.result ?? toolPart.output
  if (!rawOutput) return null

  const tryParse = (value: unknown): Record<string, unknown> | null => {
    if (!value) return null
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as Record<string, unknown>
      } catch {
        return null
      }
    }
    if (typeof value === 'object' && value !== null) {
      return value as Record<string, unknown>
    }
    return null
  }

  const dig = (obj: Record<string, unknown>, depth: number): Record<string, unknown> | null => {
    if (depth > 5) return null
    if (obj.status !== undefined || obj.task_id !== undefined) return obj

    for (const key of ['result', 'output', 'response', 'content', 'text'] as const) {
      const value = obj[key]
      if (typeof value === 'string') {
        const inner = tryParse(value)
        if (inner) {
          const found = dig(inner, depth + 1)
          if (found) return found
        }
        continue
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item !== 'object' || item === null) continue
          const found = dig(item as Record<string, unknown>, depth + 1)
          if (found) return found
        }
        continue
      }

      if (typeof value === 'object' && value !== null) {
        const found = dig(value as Record<string, unknown>, depth + 1)
        if (found) return found
      }
    }

    return null
  }

  const parsedRoot = tryParse(rawOutput)
  const parsed = parsedRoot ? dig(parsedRoot, 0) : null

  if (!parsed) return null
  if (!['pending', 'queued', 'running'].includes(String(parsed.status))) return null
  if (typeof parsed.task_id !== 'string' || typeof parsed.agent_type !== 'string') return null

  return {
    taskId: parsed.task_id as string,
    agentId: typeof parsed.agent_id === 'string' ? parsed.agent_id : undefined,
    childChatId: typeof parsed.chat_id === 'number' ? parsed.chat_id : undefined,
    agentType: parsed.agent_type as string,
    prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
    description: (parsed.description as string) ?? '',
    model: parsed.model as string | undefined,
    mode: parsed.mode as string | undefined,
  }
}
