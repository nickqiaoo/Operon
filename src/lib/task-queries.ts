import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'

export const taskKeys = {
  all: ['task'] as const,
  detail: (taskId: number) => ['task', 'detail', taskId] as const,
  assignableAgents: ['task', 'assignable-agents'] as const,
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
