import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import { queryClient } from './query-client'
import { onNode, useChatApi, useChatNodeId, useChatTransport } from './chat-api-context'
import { subscribeChatTurnStatus } from './chat-status-events'
import {
  INITIAL_AGENT_STREAM_STATE,
  parseStreamChunk,
  reduceAgentChunk,
  type AgentStreamState,
} from '@/components/editor/components/agent-stream'

/**
 * TanStack Query layer for a workflow run's detail panel: the script it was
 * launched with, and one agent's transcript.
 */
export const workflowRunKeys = {
  all: ['workflow-run'] as const,
  script: (runId: string) => ['workflow-run', runId, 'script'] as const,
  /**
   * What an agent has saved, without a turn still running (that one is watched
   * live). Keyed by its latest chat too: a handoff adds one, and the transcript
   * then has to be read again.
   */
  agentChunks: (runId: string, agentIndex: number, chatId: number | null) =>
    ['workflow-run', runId, 'agent', agentIndex, 'chunks', chatId] as const,
}

/** A run's script never changes once launched: fetched once, on first open. */
export function useWorkflowRunScript(runId: string, { enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: workflowRunKeys.script(runId),
    queryFn: async () => (await api.aiWorkflowScript(runId)).script ?? '',
    enabled,
    staleTime: Infinity,
    retry: false,
  })
}

export interface WorkflowAgentTranscript {
  /** Null until the saved part has been read once. */
  state: AgentStreamState | null
  truncated: boolean
  loading: boolean
}

/**
 * One agent's transcript, as the panel renders it.
 *
 * What the agent has saved is read once. A sub-agent is a chat, so a turn it is
 * running is watched the way any chat's is: its turn stream
 * (`GET /ai/chat/stream/:chatId`), opened when the chat status stream announces
 * the turn. When the turn ends the saved part is read again, which now holds
 * it, and the live copy is dropped. Nothing polls.
 *
 * `chatId` is the agent's latest chat (a handoff to another provider starts a
 * new one); undefined for a run from before agents ran as chats, whose output
 * is only in the run's log.
 */
export function useWorkflowAgentTranscript(
  runId: string | undefined,
  agentIndex: number,
  chatId: number | undefined,
  { enabled }: { enabled: boolean },
): WorkflowAgentTranscript {
  const chatApi = useChatApi()
  const transport = useChatTransport()
  const nodeId = useChatNodeId()
  const queryKey = onNode(workflowRunKeys.agentChunks(runId ?? '', agentIndex, chatId ?? null), nodeId)
  const saved = useQuery({
    queryKey,
    queryFn: () => chatApi.aiWorkflowAgentChunks(runId!, agentIndex, { settled: true }),
    enabled: enabled && runId != null,
    retry: false,
  })
  const live = useLiveTurnChunks(chatId, {
    enabled: enabled && runId != null,
    nodeId,
    transport,
    // The ended turn is in what is saved now; read it before the live copy goes.
    onTurnEnded: () => queryClient.refetchQueries({ queryKey, exact: true }),
  })

  const state = useMemo<AgentStreamState | null>(() => {
    // A failed read renders as an empty transcript rather than spinning forever.
    if (saved.isError) return INITIAL_AGENT_STREAM_STATE
    if (!saved.data) return null
    const chunks = live.length > 0 ? [...saved.data.chunks, ...live] : saved.data.chunks
    return chunks.reduce<AgentStreamState>(
      (acc, chunk) => reduceAgentChunk(acc, chunk as Record<string, unknown>),
      INITIAL_AGENT_STREAM_STATE,
    )
  }, [saved.data, saved.isError, live])

  return { state, truncated: saved.data?.truncated ?? false, loading: saved.isFetching }
}

const RETRY_MS = 1500

/**
 * The chunks of the turn a chat is running now, from its turn stream; empty
 * while it runs none. The stream opens with the reply so far, so reattaching
 * after a drop starts the list over rather than appending to it.
 */
function useLiveTurnChunks(
  chatId: number | undefined,
  {
    enabled,
    nodeId,
    transport,
    onTurnEnded,
  }: {
    enabled: boolean
    nodeId: string | undefined
    transport: ReturnType<typeof useChatTransport>
    onTurnEnded: () => Promise<unknown>
  },
): unknown[] {
  const [chunks, setChunks] = useState<unknown[]>([])
  // Read through a ref-like holder so a new callback identity does not reopen the stream.
  const [callbacks] = useState(() => ({ onTurnEnded }))
  callbacks.onTurnEnded = onTurnEnded

  useEffect(() => {
    if (!enabled || chatId == null) return
    let disposed = false
    let turnId: string | null = null
    let attached: AbortController | null = null

    const attach = async (turn: string) => {
      attached?.abort()
      const controller = new AbortController()
      attached = controller
      while (!disposed && turnId === turn && !controller.signal.aborted) {
        try {
          const response = await fetch(`${await transport.baseUrl()}/ai/chat/stream/${chatId}`, {
            headers: transport.authHeaders(),
            signal: controller.signal,
          })
          // 204: the turn is already over; its end arrives on the status stream.
          if (response.status === 204 || !response.ok || !response.body) return
          const received: unknown[] = []
          setChunks([])
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) return
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            let changed = false
            for (const line of lines) {
              const chunk = parseStreamChunk(line)
              if (!chunk) continue
              received.push(chunk)
              changed = true
            }
            if (changed && !controller.signal.aborted) setChunks(received.slice())
          }
        } catch {
          if (controller.signal.aborted) return
        }
        // Dropped mid-turn: the stream replays the reply from the start.
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
      }
    }

    const unsubscribe = subscribeChatTurnStatus(nodeId ? { nodeId, chatId } : { chatId }, {
      onStatus: (status) => {
        if (status.active && status.turnId && status.turnId !== turnId) {
          turnId = status.turnId
          void attach(status.turnId)
          return
        }
        if (status.active || turnId == null) return
        turnId = null
        attached?.abort()
        attached = null
        void callbacks.onTurnEnded().finally(() => {
          // A newer turn may have started meanwhile; its chunks are not ours to drop.
          if (!disposed && turnId == null) setChunks([])
        })
      },
    })

    return () => {
      disposed = true
      unsubscribe()
      attached?.abort()
      setChunks([])
    }
  }, [enabled, chatId, nodeId, transport, callbacks])

  return chunks
}
