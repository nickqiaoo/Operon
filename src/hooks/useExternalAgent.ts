import { useCallback, useEffect, useRef, useState } from 'react'
import type { UIMessage } from 'ai'
import { useEditorStore } from '@/stores/editor-store'
import { onChildTabComplete, registerTaskTab } from '@/hooks/useExternalAgentBus'

export interface ExternalAgentTask {
  taskId: string
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
    toolName.endsWith('external_agent_run')

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
  if (parsed.status !== 'pending') return null
  if (typeof parsed.task_id !== 'string' || typeof parsed.agent_type !== 'string' || typeof parsed.prompt !== 'string') return null

  return {
    taskId: parsed.task_id as string,
    agentType: parsed.agent_type as string,
    prompt: parsed.prompt as string,
    description: (parsed.description as string) ?? '',
    model: parsed.model as string | undefined,
    mode: parsed.mode as string | undefined,
  }
}


interface UseExternalAgentOptions {
  tasks: ExternalAgentTask[]
  mainChatId: string
  isGenerating: boolean
  historyLoaded: boolean
  completedTaskIds?: ReadonlySet<string>
  sendMessage: (message: { text: string }) => void
}

/**
 * Hook that detects external agent tool calls in the chat stream,
 * opens new chat tabs for each, and sends results back when complete.
 */
export function useExternalAgent({
  tasks,
  mainChatId,
  isGenerating,
  historyLoaded,
  completedTaskIds,
  sendMessage,
}: UseExternalAgentOptions) {
  const createChatTab = useEditorStore((s) => s.createChatTab)

  // Track which tasks we've already handled to avoid duplicate child tabs.
  // Historical tasks are also marked handled so restoring chat history never replays them.
  const spawnedTaskIds = useRef(new Set<string>())
  const baselineReady = useRef(false)

  useEffect(() => {
    spawnedTaskIds.current = new Set<string>()
    baselineReady.current = false
    pendingResults.current = []
    setPendingCount(0)
  }, [mainChatId])

  // After the initial message snapshot is available, absorb whatever tasks already exist.
  // These belong to history and must never auto-open child tabs again.
  useEffect(() => {
    if (!historyLoaded || baselineReady.current) return
    baselineReady.current = true
    for (const task of tasks) {
      spawnedTaskIds.current.add(task.taskId)
    }
    for (const taskId of completedTaskIds ?? []) {
      spawnedTaskIds.current.add(taskId)
    }
  }, [completedTaskIds, historyLoaded, tasks])
  // Queue results — always push here, flush via effect when not generating
  const pendingResults = useRef<Array<{ text: string }>>([])
  const [pendingCount, setPendingCount] = useState(0)

  const enqueueResult = useCallback((text: string) => {
    pendingResults.current.push({ text })
    setPendingCount((c) => c + 1) // trigger re-render to flush
  }, [])

  // Flush pending results when generation stops
  useEffect(() => {
    if (isGenerating || pendingResults.current.length === 0) return
    const next = pendingResults.current.shift()
    if (next) {
      setPendingCount((c) => Math.max(0, c - 1))
      sendMessage({ text: next.text })
    }
  }, [isGenerating, sendMessage, pendingCount])

  // Historical restore is display-only.
  // While the parent chat is idle, absorb tasks but do not execute them.
  // Only tasks that appear during a live parent generation may auto-open child tabs.
  useEffect(() => {
    if (!baselineReady.current) return
    if (!isGenerating) {
      for (const task of tasks) {
        spawnedTaskIds.current.add(task.taskId)
      }
      for (const taskId of completedTaskIds ?? []) {
        spawnedTaskIds.current.add(taskId)
      }
      return
    }
    for (const task of tasks) {
      if (spawnedTaskIds.current.has(task.taskId)) continue
      spawnedTaskIds.current.add(task.taskId)

      // Open new chat tab in background
      const tabId = createChatTab(task.agentType, `Agent: ${task.description}`, {
        background: true,
        input: task.prompt,
        autoRun: true,
        timestamp: Date.now(),
        modelId: task.model,
        // Server-resolved non-interactive mode: this tab runs in the background
        // with nobody watching, so it must not stop to ask for permission.
        modeId: task.mode,
      }, true)
      registerTaskTab(task.taskId, { tabId, providerId: task.agentType, description: task.description })

      // Listen for child tab completion via event bus
      // Handler is auto-removed after firing once (emitTabComplete deletes it)
      onChildTabComplete(tabId, (result, childDbChatId) => {
        const truncated = result.length > 20000 ? result.slice(0, 20000) + '\n...(truncated)' : result
        const notification = `[External Agent Result]
<external-agent-result>
<task-id>${task.taskId}</task-id>
<agent-type>${task.agentType}</agent-type>
<description>${task.description}</description>
<child-chat-id>${tabId}</child-chat-id>
${childDbChatId !== undefined ? `<db-chat-id>${childDbChatId}</db-chat-id>` : ''}
<result>
${truncated}
</result>
</external-agent-result>
Process the external agent's result above.`
        enqueueResult(notification)
      })
    }
  }, [completedTaskIds, createChatTab, enqueueResult, isGenerating, tasks])
}
