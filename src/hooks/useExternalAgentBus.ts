/**
 * Simple event bus for external agent tab completion + task→tab mapping.
 */

type CompletionHandler = (result: string, dbChatId?: number) => void

const listeners = new Map<string, CompletionHandler>()

/** Parent: register a handler for when a child tab completes */
export function onChildTabComplete(tabId: string, handler: CompletionHandler) {
  console.log(`[ExternalAgentBus] onChildTabComplete registered for tabId=${tabId}`)
  listeners.set(tabId, handler)
  return () => { listeners.delete(tabId) }
}

/** Child: notify that this tab's chat has completed */
export function emitTabComplete(tabId: string, result: string, dbChatId?: number) {
  const handler = listeners.get(tabId)
  if (handler) {
    handler(result, dbChatId)
    listeners.delete(tabId)
  }
}

// ---- Task ID → Tab info mapping ----

interface TaskTabInfo {
  tabId: string
  providerId: string
  description: string
}

const taskToTab = new Map<string, TaskTabInfo>()

/** Register a taskId → tab info mapping when spawning a child tab */
export function registerTaskTab(taskId: string, info: TaskTabInfo) {
  taskToTab.set(taskId, info)
}

/** Look up the tab info for a given task ID */
export function getTabInfoForTask(taskId: string): TaskTabInfo | undefined {
  return taskToTab.get(taskId)
}
