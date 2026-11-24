import { useEffect } from 'react'
import { subscribeEvents } from '@/lib/event-stream'
import { reloadTree } from '@/lib/workspace-nav'
import { useProjectStore } from '@/stores/project-store'

type ProjectTreeFrame = { type: 'ready' } | { type: 'tree_changed'; projectId: number }

/**
 * Keep the sidebar's project tree in step with workspaces made or removed on the
 * server (a channel agent's worktree, a board task's), which no client action
 * reloads. Mount once per shell.
 *
 * The stream opens with `ready`. The first one is skipped (the app's own first
 * load brings the tree); a later one is a reconnect that may have missed
 * changes, so it reloads. Bursts coalesce into one read.
 */
export function useProjectTreeStream() {
  useEffect(() => {
    let seenReady = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer != null) return
      timer = setTimeout(() => {
        timer = null
        if (!useProjectStore.getState().projectsLoaded) return
        reloadTree().catch((error) => console.error('Failed to refresh project navigation:', error))
      }, 150)
    }
    const subscription = subscribeEvents<ProjectTreeFrame>('projects', {
      onEvent: (frame) => {
        if (frame.type === 'ready') {
          if (seenReady) schedule()
          seenReady = true
          return
        }
        schedule()
      },
    })
    return () => {
      if (timer != null) clearTimeout(timer)
      subscription.close()
    }
  }, [])
}
