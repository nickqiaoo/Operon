import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SshEnvironmentProfile, SshEnvironmentRef } from '@shared/ssh-environment'
import { requestVia } from './api-client'
import { onNode, useChatNodeId, useChatTransport } from './chat-api-context'

/**
 * SSH environments as a chat sees them: the saved profiles of the chat's machine, and the
 * additional environments one Operon chat has attached. Read on the chat's machine.
 */
export const sshEnvironmentKeys = {
  all: ['ssh-environments'] as const,
  chat: (chatId: number) => ['ssh-environments', 'chat', chatId] as const,
}

/** An attached environment; `connected` is known only while the chat's session is loaded. */
export type ChatEnvironment = SshEnvironmentRef & { target: string; connected?: boolean }

/** The saved SSH profiles of the chat's machine. */
export function useSshEnvironmentProfiles(enabled: boolean) {
  const nodeId = useChatNodeId()
  const transport = useChatTransport()
  return useQuery({
    queryKey: onNode(sshEnvironmentKeys.all, nodeId),
    queryFn: () => requestVia<SshEnvironmentProfile[]>(transport, '/ssh-environments'),
    staleTime: 30_000,
    enabled,
  })
}

/** The environments chat `chatId` has attached besides its default one. */
export function useChatEnvironments(chatId: number | undefined) {
  const nodeId = useChatNodeId()
  const transport = useChatTransport()
  return useQuery({
    queryKey: onNode(sshEnvironmentKeys.chat(chatId ?? -1), nodeId),
    queryFn: () => requestVia<ChatEnvironment[]>(transport, `/ssh-environments/chats/${chatId}`),
    enabled: chatId !== undefined,
    // Connection state changes on the server (a host dropping off), so a reopened picker asks again.
    refetchOnMount: 'always',
  })
}

/** Attach, reconnect or detach one environment of chat `chatId`. */
export function useChangeChatEnvironment(chatId: number | undefined) {
  const nodeId = useChatNodeId()
  const transport = useChatTransport()
  const client = useQueryClient()
  const queryKey = onNode(sshEnvironmentKeys.chat(chatId ?? -1), nodeId)
  return useMutation({
    mutationFn: ({ id, add, localDir }: { id: string; add: boolean; localDir?: string }) =>
      requestVia<ChatEnvironment[]>(transport, `/ssh-environments/chats/${chatId}`, {
        method: 'PATCH',
        body: JSON.stringify({ id, add, ...(localDir ? { localDir } : {}) }),
      }),
    onSuccess: (environments) => {
      client.setQueryData(queryKey, environments)
      void client.invalidateQueries({ queryKey })
    },
  })
}

/** Check that a saved profile connects (its host key trusted) before a draft relies on it. */
export function useTestSshEnvironment() {
  const transport = useChatTransport()
  return useMutation({
    mutationFn: async (profile: SshEnvironmentProfile) => {
      const result = await requestVia<{ success?: boolean }>(transport, '/ssh-environments/test', {
        method: 'POST',
        body: JSON.stringify(profile),
      })
      if (!result.success) throw new Error('Verify the host key in Settings before connecting.')
    },
  })
}
