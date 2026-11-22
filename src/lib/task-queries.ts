import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'

export const taskKeys = {
  all: ['task'] as const,
  detail: (taskId: number) => ['task', 'detail', taskId] as const,
  assignableAgents: ['task', 'assignable-agents'] as const,
  byWorkspace: (workspaceId: number) => ['task', 'by-workspace', workspaceId] as const,
  byChat: (chatId: number) => ['task', 'by-chat', chatId] as const,
}

/** The task a dispatched worktree belongs to; null for a workspace made by hand. */
export function useTaskByWorkspace(workspaceId: number | null) {
  return useQuery({
    queryKey: taskKeys.byWorkspace(workspaceId ?? 0),
    queryFn: async () => (await api.taskGetByWorkspace(workspaceId!)).task ?? null,
    enabled: workspaceId != null,
    staleTime: 60_000,
  })
}

/** The task a dispatched conversation works on (shared workspace included); null otherwise. */
export function useTaskByChat(chatId: number | null) {
  return useQuery({
    queryKey: taskKeys.byChat(chatId ?? 0),
    queryFn: async () => (await api.taskGetByChat(chatId!)).task ?? null,
    enabled: chatId != null,
    staleTime: 60_000,
  })
}

export function useTask(taskId: number) {
  return useQuery({
    queryKey: taskKeys.detail(taskId),
    queryFn: async () => (await api.taskGet(taskId)).task,
  })
}

/** The agents a task can be handed to. Asked for when a picker opens, not with every card. */
export function useAssignableAgents(enabled: boolean) {
  return useQuery({
    queryKey: taskKeys.assignableAgents,
    queryFn: async () => (await api.agentList()).agents,
    enabled,
  })
}

export function useDispatchTask(taskId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (agentId: number) => (await api.taskDispatch(taskId, agentId)).task,
    onSuccess: (task) => queryClient.setQueryData(taskKeys.detail(taskId), task),
  })
}
