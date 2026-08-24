import { randomUUID } from 'crypto'
import type { UIMessage } from 'ai'
import type { ProviderDescriptor } from '@operon/agent-runtime'
import type { AiChatRequest, AssistantContinuationState } from './types.js'
import { getSessionManager, getProjectStorage } from './state.js'

const DEFAULT_PROVIDER_ID = 'claude-code'

export const createSteerUserMessage = (content: string, turnMessageId?: string): UIMessage => ({
  id: randomUUID(),
  role: 'user',
  metadata: {
    steer: true,
    ...(turnMessageId ? { turnMessageId } : {}),
  },
  parts: [{ type: 'text', text: content.trim() }],
})

export const resolveProviderId = (payload: AiChatRequest): string =>
  payload.providerId ?? DEFAULT_PROVIDER_ID

export const findLatestUserMessage = (messages: UIMessage[]): UIMessage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return messages[index]
    }
  }
  return undefined
}

export const findLastAssistantMessage = (messages: UIMessage[]): AssistantContinuationState | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') {
      return {
        assistantIndex: index,
        assistantMessage: messages[index],
      }
    }
  }
  return null
}

type ProviderDescriptorPatch = Partial<
  Pick<
    ProviderDescriptor,
    'currentModelId' | 'currentModeId' | 'currentThinkingLevel' | 'currentServiceTier' | 'slashCommands'
  >
>

export const getProviderDescriptorPatch = (
  providerId: string,
): ProviderDescriptorPatch | undefined => {
  const sessionManager = getSessionManager()
  for (const session of sessionManager.findByProvider(providerId)) {
    return session.runtime.getDescriptorPatch?.()
  }
  return undefined
}

export const getProviderBaseDescriptor = async (
  providerId: string,
): Promise<ProviderDescriptor | undefined> => {
  const sessionManager = getSessionManager()
  if (!sessionManager.hasProvider(providerId)) {
    return undefined
  }

  const provider = sessionManager.createProvider(providerId)
  await provider.fetchInitInfo?.()
  return provider.getDescriptor()
}

export const getProviderDescriptor = async (providerId: string): Promise<ProviderDescriptor | undefined> => {
  const descriptor = await getProviderBaseDescriptor(providerId)
  if (!descriptor) return undefined

  const patch = getProviderDescriptorPatch(providerId)
  return patch ? { ...descriptor, ...patch } : descriptor
}

export const createErrorResponse = (label: string, err: unknown): Response => {
  console.error(label, err)
  const errorMessage = err instanceof Error ? err.message : 'Failed to setup AI provider'
  return new Response(JSON.stringify({ error: errorMessage }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const createChatResponseHeaders = (baseHeaders: Headers, chatId: number): Headers => {
  const headers = new Headers(baseHeaders)
  headers.set('X-Chat-Id', String(chatId))
  return headers
}

export const resolveWorkspaceCwd = (workspaceId?: number): string => {
  const projectStorage = getProjectStorage()
  if (!workspaceId || !projectStorage) {
    throw new Error('workspaceId is required to resolve working directory')
  }

  const workspace = projectStorage.getWorkspace(workspaceId)
  if (!workspace) {
    throw new Error('workspaceId is required to resolve working directory')
  }

  return workspace.worktreePath
}
