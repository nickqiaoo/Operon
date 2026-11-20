import { useEffect, useRef } from "react"

import { startNewChat } from "@/lib/new-chat"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useInboxStore } from "@/stores/inbox-store"
import { useNavigationStore } from "@/stores/navigation-store"
import type { Notification } from "@/types/notification"
import type { TrayCommand } from "@/types/tray"

interface TrayCommandHandlers {
  /** Land on a notification's source, the same as clicking its inbox row. */
  openNotification: (notification: Notification) => void
}

/** Runs what the macOS menu-bar (tray) menu asks of the window. */
export function useTrayCommands(handlers: TrayCommandHandlers): void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onTrayCommand) return

    const run = (command: TrayCommand) => {
      switch (command.type) {
        case "new-chat":
          void startNewChat()
          break
        case "open-notification": {
          const n = command.notification
          if (n.readAt == null) void useInboxStore.getState().markRead([n.id])
          handlersRef.current.openNotification(n)
          break
        }
        case "open-inbox": {
          // Unread notices live in the sidebar's Focus view now; bring it out.
          const shell = useAppShellStore.getState()
          shell.setSidebarFocus(true)
          shell.setSidebarCollapsed(false)
          useNavigationStore.getState().showWorkbench()
          break
        }
        case "open-assistant":
          useNavigationStore.getState().showMain({ kind: "assistant" })
          break
      }
    }

    const unsubscribe = api.onTrayCommand(run)
    // Clicked while this window was still loading: the main process kept it.
    void api.takePendingTrayCommand?.().then((pending) => {
      if (pending) run(pending)
    })
    return unsubscribe
  }, [])
}
