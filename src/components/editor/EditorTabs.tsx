import { Bot, History, LayoutDashboard, Loader2, Plus, SquareTerminal, Users, X } from "lucide-react"
import googleLogo from "@/assets/logos/google.svg"
import openaiLogo from "@/assets/logos/openai.svg"
import anthropicLogo from "@/assets/logos/claude.svg"
import opencodeLogo from "@/assets/logos/opencode.svg"
import kimiLogo from "@/assets/logos/kimi.svg"
import grokLogo from "@/assets/logos/grok.svg"
import vercelLogo from "@/assets/logos/vercel.svg"
import customLogo from "@/assets/logos/custom.svg"
import copilotLogo from "@/assets/logos/copilot.svg"
import cursorLogo from "@/assets/logos/cursor.svg"

const providerLogos: Record<string, string> = {
  google: googleLogo,
  gemini: googleLogo,
  kimi: kimiLogo,
  moonshot: kimiLogo,
  moonshotai: kimiLogo,
  openai: openaiLogo,
  codex: openaiLogo,
  anthropic: anthropicLogo,
  "claude-code": anthropicLogo,
  opencode: opencodeLogo,
  grok: grokLogo,
  xai: grokLogo,
  vercel: vercelLogo,
  custom: customLogo,
  copilot: copilotLogo,
  cursor: cursorLogo,
}
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { EditorTab } from "@/types/editor"
import { useEditorStore } from "@/stores/editor-store"
import { useStreamingStore } from "@/stores/streaming-store"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { FileIcon } from "@/components/FileIcon"
import { useChatHistoryList } from "@/lib/chat-queries"
import { WorkspaceTaskButton } from "./WorkspaceTaskButton"

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TERMINAL_CLI_LAUNCH } from "@/lib/terminal-clis"
import { useEffect, useRef, useState } from "react"
import { FormattedMessage, useIntl, type IntlShape } from "react-intl"

type ProviderOption = { id: string; label: string; logo: string; available: boolean }

interface EditorTabsProps {
  tabs: EditorTab[]
  activeTabId: string
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
  onNewChat: (providerId: string) => void
  onNewTerminal: (providerId: string, label: string) => void
  onOpenChat: (chatId: string, title?: string, options?: EditorTab["options"], providerId?: string, isSubAgent?: boolean) => void
}

/**
 * Conversations fetched per request. A workspace can accumulate hundreds of
 * chats; fetching and mounting them all made opening the popover a full table
 * scan plus a few hundred rows of DOM. One page fills the 60vh panel with room
 * to spare, and scrolling to the bottom pulls the next one.
 */
const HISTORY_PAGE_SIZE = 40

const getHistoryLogo = (providerId?: string): string | undefined => {
  if (!providerId) return undefined
  return providerLogos[providerId]
}

const formatRelativeTime = (timestamp: number, intl: IntlShape): string => {
  const now = Date.now()
  const diffMs = now - timestamp
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return intl.formatMessage({ id: "editor.time.justNow", defaultMessage: "just now" })
  if (diffMin < 60) return intl.formatMessage({ id: "editor.time.minutesAgo", defaultMessage: "{count}m ago" }, { count: diffMin })
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return intl.formatMessage({ id: "editor.time.hoursAgo", defaultMessage: "{count}h ago" }, { count: diffHr })
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return intl.formatMessage({ id: "editor.time.daysAgo", defaultMessage: "{count}d ago" }, { count: diffDay })
  const diffMon = Math.floor(diffDay / 30)
  return intl.formatMessage({ id: "editor.time.monthsAgo", defaultMessage: "{count}mo ago" }, { count: diffMon })
}

export function EditorTabs({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewChat,
  onNewTerminal,
  onOpenChat,
}: EditorTabsProps) {
  const intl = useIntl()
  const setTabChatId = useEditorStore((s) => s.setTabChatId)
  const [historyOpen, setHistoryOpen] = useState(false)
  const currentWorkspaceId = useEditorStore((state) => state.currentWorkspaceId)
  // Keyed by tab id, written by every mounted ChatPanel — including the ones the
  // user isn't looking at, which is the whole point of showing it up here.
  const streamingTabIds = useStreamingStore((s) => s.streamingTabIds)
  const unseenTabIds = useStreamingStore((s) => s.unseenTabIds)

  // Cached per workspace, so opening this right after a switch can only ever
  // show this workspace's conversations or a skeleton — never the ones from the
  // workspace we just left.
  const {
    items: historyItems,
    hasMore: historyHasMore,
    isInitialLoading: historyLoading,
    isLoadingMore: historyLoadingMore,
    loadMore: loadMoreHistory,
  } = useChatHistoryList({
    workspaceId: currentWorkspaceId,
    pageSize: HISTORY_PAGE_SIZE,
    enabled: historyOpen,
  })

  // Providers backing the new-tab menu (Chat + Terminal submenus). Fetched once
  // when the "+" menu first opens.
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [newTabOpen, setNewTabOpen] = useState(false)
  useEffect(() => {
    if (!newTabOpen || providers.length > 0) return
    let active = true
    api.getProviders().then((list) => {
      if (active) setProviders(list)
    }).catch(() => {})
    return () => { active = false }
  }, [newTabOpen, providers.length])

  const terminalProviders = providers.filter((p) => p.id in TERMINAL_CLI_LAUNCH)

  const handleHistoryScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!historyHasMore || historyLoadingMore) return
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      loadMoreHistory()
    }
  }

  const scrollRef = useRef<HTMLDivElement>(null)

  const handleWheel = (e: React.WheelEvent) => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft += e.deltaY
    }
  }

  return (
    <div className="h-10 flex items-center border-b border-border/50 bg-background px-2 gap-2">
      <div
        ref={scrollRef}
        onWheel={handleWheel}
        className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto scrollbar-none scroll-smooth"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            data-testid={`tab-${index}`}
            data-tab-active={activeTabId === tab.id ? 'true' : undefined}
            className={cn(
              "relative flex w-32 items-center py-1.5 pl-7 pr-2 text-sm cursor-pointer group transition-colors select-none border-b-[2px]",
              activeTabId === tab.id
                ? "border-tint font-semibold text-foreground bg-transparent"
                : "text-muted-foreground border-transparent hover:text-foreground/80 hover:bg-transparent"
            )}
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.type === "terminal" ? (
              <img
                src={providerLogos[tab.providerId ?? "claude-code"] ?? anthropicLogo}
                alt={tab.title}
                className="absolute left-2 size-3.5 shrink-0 dark:invert"
              />
            ) : tab.type === "diff" ? (
              <FileIcon name={tab.title.replace(" (diff)", "")} className="absolute left-2 size-3.5 shrink-0" />
            ) : tab.isSubAgent ? (
              <Bot className="absolute left-2 size-3.5 shrink-0 text-blue-500" />
            ) : (
              <img src={providerLogos[tab.providerId ?? tab.provider ?? 'google'] ?? googleLogo} alt="model" className="absolute left-2 size-3.5 shrink-0 dark:invert" />
            )}
            <span className="truncate font-medium">{tab.title}</span>
            {streamingTabIds.has(tab.id) ? (
              <span
                className="ml-1 flex shrink-0 items-center"
                title={intl.formatMessage({ id: "editor.tabs.generating", defaultMessage: "Generating…" })}
              >
                <Loader2 className="size-3 animate-spin text-tint" aria-hidden />
                <span className="sr-only">
                  <FormattedMessage id="editor.tabs.generating" defaultMessage="Generating…" />
                </span>
              </span>
            ) : unseenTabIds.has(tab.id) ? (
              // Done generating, and the user hasn't come back to it yet. Cleared
              // by ChatPanel as soon as this tab becomes the active one.
              <span
                className="ml-1 flex shrink-0 items-center"
                title={intl.formatMessage({ id: "editor.tabs.unread", defaultMessage: "New reply" })}
              >
                <span className="size-1.5 rounded-full bg-status-info" aria-hidden />
                <span className="sr-only">
                  <FormattedMessage id="editor.tabs.unread" defaultMessage="New reply" />
                </span>
              </span>
            ) : null}
            {tab.closable !== false && (
              <button
                type="button"
                data-testid={`tab-close-${index}`}
                aria-label={intl.formatMessage({ id: "editor.tabs.closeAria", defaultMessage: "Close {title}" }, { title: tab.title })}
                title={intl.formatMessage({ id: "appShell.closeTab", defaultMessage: "Close tab" })}
                className="absolute inset-y-0 right-0 flex w-8 items-center justify-center opacity-0 transition-opacity pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseTab(tab.id)
                }}
              >
                <span
                  aria-hidden
                  className="absolute inset-0 bg-gradient-to-l from-background via-background/95 to-transparent"
                />
                <X className="relative z-10 h-3 w-3 text-muted-foreground hover:text-foreground" />
              </button>
            )}
          </div>
        ))}

        {/* New Tab Menu Integrated in Tab List */}
        <DropdownMenu open={newTabOpen} onOpenChange={setNewTabOpen}>
          <DropdownMenuTrigger asChild>
            <button
              data-testid="new-tab-button"
              className="flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:bg-background/50 hover:text-foreground transition-colors shrink-0"
              title={intl.formatMessage({ id: "tab.newTab", defaultMessage: "New tab" })}
              aria-label={intl.formatMessage({ id: "tab.newTab", defaultMessage: "New tab" })}
            >
              <Plus className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-44"
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            {/* New Chat ▸ pick a provider */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="new-chat-menuitem" className="gap-2">
                <Bot className="size-4" />
                <FormattedMessage id="editor.tabs.newChat" defaultMessage="New Chat" />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-44">
                {providers.map((p) => (
                  <DropdownMenuItem
                    key={p.id}
                    data-testid={`provider-option-${p.id}`}
                    className="gap-2"
                    disabled={!p.available}
                    onClick={() => onNewChat(p.id)}
                  >
                    <img
                      src={providerLogos[p.id] ?? providerLogos[p.logo] ?? googleLogo}
                      alt={p.label}
                      className="size-4 dark:invert"
                    />
                    {p.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* New Terminal ▸ pick a CLI */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="new-terminal-menuitem" className="gap-2">
                <SquareTerminal className="size-4" />
                <FormattedMessage id="editor.tabs.newTerminal" defaultMessage="New Terminal" />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-44">
                {terminalProviders.map((p) => (
                  <DropdownMenuItem
                    key={p.id}
                    data-testid={`terminal-option-${p.id}`}
                    className="gap-2"
                    disabled={!p.available}
                    onClick={() => onNewTerminal(p.id, p.label)}
                  >
                    <img
                      src={providerLogos[p.id] ?? providerLogos[p.logo] ?? googleLogo}
                      alt={p.label}
                      className="size-4 dark:invert"
                    />
                    {p.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex items-center gap-1 shrink-0 pl-2 border-l border-border/50">
        <WorkspaceTaskButton />
        <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              title={intl.formatMessage({ id: "editor.tabs.chatHistory", defaultMessage: "Chat history" })}
              aria-label={intl.formatMessage({ id: "editor.tabs.chatHistory", defaultMessage: "Chat history" })}
              className="text-muted-foreground hover:text-foreground"
            >
              <History className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={6}
            className="w-80 p-0 border-border/40 shadow-float"
          >
            <div className="px-3 py-2 border-b border-border/40">
              <span className="text-sm font-medium text-foreground"><FormattedMessage id="editor.tabs.chatHistory" defaultMessage="Chat history" /></span>
            </div>
            <div className="max-h-[60vh] overflow-auto code-scrollbar" onScroll={handleHistoryScroll}>
              {historyLoading ? (
                <div className="flex flex-col gap-1 py-1">
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-2">
                      <Skeleton className="size-4 shrink-0 rounded" />
                      <Skeleton className="h-3.5 flex-1" style={{ opacity: 1 - i * 0.12 }} />
                      <Skeleton className="h-3 w-8 shrink-0" style={{ opacity: 1 - i * 0.12 }} />
                    </div>
                  ))}
                </div>
              ) : historyItems.length === 0 ? (
                <div className="text-sm text-muted-foreground py-6 text-center">
                  <FormattedMessage id="editor.history.empty" defaultMessage="No conversations yet." />
                </div>
              ) : (
                <div className="flex flex-col py-1">
                  {historyItems.map((item) => {
                    const tabId = `chat:${item.id}`
                    const isCanvas = item.tp === 'canvas'
                    const isSubAgent = item.tp === 'subagent'
                    const isTeammate = item.tp === 'teammate'
                    const logo = getHistoryLogo(item.providerId)
                    return (
                      <button
                        key={item.id}
                        className="flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent transition-colors"
                        onClick={() => {
                          onOpenChat(tabId, item.title, undefined, item.providerId, isSubAgent || undefined)
                          setTabChatId(tabId, item.id)
                          setHistoryOpen(false)
                        }}
                      >
                        {isSubAgent ? (
                          <Bot className="size-4 shrink-0 text-blue-500" />
                        ) : isTeammate ? (
                          <Users className="size-4 shrink-0 text-status-info" />
                        ) : isCanvas ? (
                          <LayoutDashboard className="size-4 shrink-0 text-purple-500" />
                        ) : logo ? (
                          <img
                            src={logo}
                            alt="model"
                            className="size-4 shrink-0 dark:invert"
                          />
                        ) : (
                          <div className="size-4 shrink-0" aria-hidden />
                        )}
                        <span className="font-medium truncate min-w-0 flex-1">
                          {item.title}
                        </span>
                        {isSubAgent && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 shrink-0">
                            <FormattedMessage id="editor.history.subAgent" defaultMessage="Sub Agent" />
                          </span>
                        )}
                        {isCanvas && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 shrink-0">
                            <FormattedMessage id="editor.history.workflow" defaultMessage="Workflow" />
                          </span>
                        )}
                        {isTeammate && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-info/10 text-status-info shrink-0">
                            <FormattedMessage id="editor.history.teammate" defaultMessage="Teammate" />
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                          {formatRelativeTime(item.updatedAt, intl)}
                        </span>
                      </button>
                    )
                  })}
                  {historyLoadingMore && (
                    <div className="py-2 text-center text-xs text-muted-foreground/60">
                      <FormattedMessage id="editor.history.loadingMore" defaultMessage="Loading more…" />
                    </div>
                  )}
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
