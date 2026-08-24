import { queryClient } from './query-client'
import { useProjectStore } from '@/stores/project-store'

/**
 * Drop every cache scoped to the backend node before switching to another one.
 *
 * Both caches key on ids the node hands out — project/workspace ids in the
 * project store, workspace ids in the query keys — and those are only unique
 * *within* a node. Machine A's workspace 3 and machine B's workspace 3 are
 * unrelated, so anything left over would be shown as if it belonged to the new
 * machine. The mobile shell reloads the page after switching and would survive
 * without this; the desktop web gate swaps the node in place and would not.
 */
export function resetNodeScopedCaches(): void {
  useProjectStore.getState().resetProjects()
  queryClient.clear()
}
