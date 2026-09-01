import { BrowserTab } from "../content/BrowserTab"
import { ReviewTab } from "../content/ReviewTab"
import { SideChatTab } from "../content/SideChatTab"
import { TerminalTab } from "../content/TerminalTab"
import { WorkspaceBrowserTab } from "../content/WorkspaceBrowserTab"
import { WorkflowTab } from "../content/WorkflowTab"
import type { PanelId, Tab } from "./types"

interface TabContentProps {
  panelId: PanelId
  tab: Tab
  /**
   * True if this tab is the active one in its panel. Some content (e.g.
   * BrowserTab) uses this to decide whether to show its overlay webview.
   */
  isActive: boolean
}

/**
 * Renders the body of a tab based on its payload type.
 *
 *   workspace-browser → @pierre/trees + preview pane
 *   diff              → (later)
 *   review            → @pierre/diffs multi-file
 *   side-chat         → ChatPanel on a forked conversation
 *   browser           → webview overlay (browserManager)
 *   terminal          → xterm + PTY
 *   workflow          → live runs + each sub-agent's stream
 *   placeholder       → demo only
 */
export function TabContent({ panelId, tab, isActive }: TabContentProps) {
  switch (tab.payload.type) {
    case "workspace-browser":
      return (
        <WorkspaceBrowserTab
          panelId={panelId}
          tabId={tab.tabId}
          rootPath={tab.payload.rootPath}
          selectedPath={tab.payload.selectedPath}
          gotoLine={tab.payload.gotoLine}
          gotoNonce={tab.payload.gotoNonce}
        />
      )
    case "review":
      return <ReviewTab tabId={tab.tabId} rootPath={tab.payload.rootPath} />
    case "side-chat":
      return (
        <SideChatTab
          chatId={tab.payload.chatId}
          parentChatId={tab.payload.parentChatId}
          isActive={isActive}
        />
      )
    case "terminal":
      return (
        <TerminalTab
          terminalId={tab.payload.terminalId}
          cwd={tab.payload.cwd}
          isActive={isActive}
        />
      )
    case "browser":
      return (
        <BrowserTab
          panelId={panelId}
          tabId={tab.tabId}
          instanceId={tab.payload.instanceId}
          initialUrl={tab.payload.url}
          isActive={isActive}
          chatId={tab.payload.chatId}
        />
      )
    case "workflow":
      return <WorkflowTab />
    case "placeholder":
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6">
          <div className="text-sm text-foreground">{tab.payload.label}</div>
          <div className="text-xs text-muted-foreground">
            Phase 1 placeholder — content wired in later phases.
          </div>
        </div>
      )
    case "diff":
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6">
          <div className="text-sm font-medium">{tab.title}</div>
          <div className="text-xs text-muted-foreground">
            Not implemented yet ({tab.payload.type})
          </div>
        </div>
      )
  }
}
