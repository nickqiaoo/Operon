import { useEffect, useMemo, useRef, useState } from "react"
import { Activity, ArrowLeft, Loader2, MessageSquarePlus, SquarePen } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { queryClient } from "@/lib/query-client"
import { providersQuery, useProviders } from "@/lib/provider-queries"
import { cn } from "@/lib/utils"
import { useChatHistoryList, type ChatHistoryListItem } from "@/lib/chat-queries"
import { Skeleton } from "@/components/ui/skeleton"
import { useEditorStore } from "@/stores/editor-store"
import { useChatPresenceStore } from "@/stores/chat-presence-store"
import { useSessionPanelStore } from "@/stores/session-panel-store"
import { useBackHandler } from "@/hooks/useAndroidBackButton"
import { MobileHeader, useMobileContentBottom, useMobileContentOffset } from "./MobileHeader"
import { ChatPanel } from "@/components/editor/ChatPanel"
import { hasNativeTabBar, NativeShell } from "@/lib/native"
import { ProviderIcon } from "@/components/editor/components/ModelSelectorPanel"
import { providerLogoName } from "@/lib/provider-logos"
import { AgentAvatar } from "@/components/icons/AgentAvatar"
import { MobileSheet } from "./MobileSheet"
import { MobileSpecChatsList, type MobileSpecChatTarget } from "./MobileSpecChatsList"
import { formatRelativeTime } from "@/lib/format"
import { specKeys } from "@/lib/spec-queries"
import { PullToRefresh } from "./PullToRefresh"
import { getChatDraft } from "@/lib/chat-drafts"

interface Provider {
  id: string
  label: string
}

type ChatHistoryItem = ChatHistoryListItem

interface MobileChatsScreenProps {
  specId?: number
  onOpenSpecChat: (target: MobileSpecChatTarget) => void
  keyboardOpen?: boolean
  /** Inbox deep-link: open this DB chat directly. Cleared via onDeepLinkConsumed. */
  openChatId?: number | null
  openChatTitle?: string
  /** The deep-linked chat is an agent's conversation (tp 'subagent'), which keeps its model. */
  openChatSubAgent?: boolean
  onDeepLinkConsumed?: () => void
  /**
   * Reports whether a conversation is open, so the shell can drop its top
   * context bar and bottom tab bar and give the transcript the full screen.
   */
  onImmersiveChange?: (immersive: boolean) => void
}

/** Conversations fetched per request; more load as the list scrolls. */
const CHATS_PAGE_SIZE = 30

/**
 * Per-workspace agent chats. Reuses the same editor-store tab model and
 * {@link ChatPanel} the desktop uses, so streaming, tool calls, approvals and
 * inline turn-diffs all come along unchanged — just single-column with a
 * list ⇄ conversation push instead of tabs.
 *
 * The editor store only holds the tabs opened this session (it isn't
 * persisted), so the list is seeded from the DB via `chatHistoryList` scoped to
 * the active workspace — otherwise switching workspace or reloading the web app
 * would show "No chats yet" even though past conversations exist.
 */
export function MobileChatsScreen({ specId, onOpenSpecChat, keyboardOpen = false, openChatId, openChatTitle, openChatSubAgent, onDeepLinkConsumed, onImmersiveChange }: MobileChatsScreenProps) {
  const intl = useIntl()
  const sessionPanelOffered = useSessionPanelStore((s) => s.owner != null && !s.open)
  const setSessionPanelOpen = useSessionPanelStore((s) => s.setOpen)
  const contentOffset = useMobileContentOffset()
  const contentBottom = useMobileContentBottom()
  const tabs = useEditorStore((s) => s.tabs)
  const currentWorkspaceId = useEditorStore((s) => s.currentWorkspaceId)
  const createChatTab = useEditorStore((s) => s.createChatTab)
  const openChatTab = useEditorStore((s) => s.openChatTab)
  const setTabChatId = useEditorStore((s) => s.setTabChatId)
  const setActiveTab = useEditorStore((s) => s.setActiveTab)
  const closeTab = useEditorStore((s) => s.closeTab)
  // Server-reported turn presence for every chat (the shell keeps the stream
  // open), so a row shows its turn running even with no panel mounted.
  const runningChatIds = useChatPresenceStore((s) => s.runningChatIds)

  const [openId, setOpenId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  // Subscribed for the whole screen, not just while the picker is open, so the
  // "New" tap finds the list already cached instead of waiting on a round trip
  // through the broker before the sheet can appear.
  const { data: providerList } = useProviders()
  const providers = useMemo<Provider[]>(
    () => (providerList ?? []).map((p) => ({ id: p.id, label: p.label })),
    [providerList],
  )

  const chatTabs = useMemo(() => tabs.filter((t) => t.type === "chat"), [tabs])
  const openTab = useMemo(() => chatTabs.find((t) => t.id === openId) ?? null, [chatTabs, openId])

  // Persisted conversations for the active workspace, cached per workspace so a
  // switch can't leave the previous workspace's chats on screen while the new
  // ones load. `staleTime: 0` keeps the old refresh-on-return behaviour: coming
  // back from a conversation (openId → null) re-enables the query and refetches,
  // while the cached rows stay painted, so a chat just used shows up updated
  // without the list blanking.
  const {
    items: history,
    hasMore,
    isInitialLoading: loading,
    isLoadingMore: loadingMore,
    loadMore,
    refresh: refreshHistory,
  } = useChatHistoryList({
    workspaceId: currentWorkspaceId,
    tp: currentWorkspaceId == null ? "chat" : undefined,
    pageSize: CHATS_PAGE_SIZE,
    enabled: specId == null && openId === null,
    staleTime: 0,
  })

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (specId != null || !hasMore || loadingMore) return
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) loadMore()
  }

  // Open chats that aren't in the fetched history yet (freshly created, not yet
  // persisted, or created since the last refresh). Shown above the history so a
  // brand-new chat stays visible immediately.
  const historyIds = useMemo(() => new Set(history.map((h) => h.id)), [history])
  const liveTabs = useMemo(
    () =>
      chatTabs.filter((t) => {
        if (t.chatId != null && historyIds.has(t.chatId)) return false
        const m = /^chat:(\d+)$/.exec(t.id)
        if (m && historyIds.has(Number(m[1]))) return false
        return true
      }),
    [chatTabs, historyIds]
  )

  // If the open chat disappears (workspace switch parks its tabs), fall back to
  // the list rather than rendering a dangling ChatPanel.
  useEffect(() => {
    if (openId && !chatTabs.some((t) => t.id === openId)) setOpenId(null)
  }, [openId, chatTabs])

  // Tell the shell to go chrome-less while a conversation is open, and to come
  // back when we leave it — including via unmount (switching bottom tabs).
  const immersive = openTab !== null
  useEffect(() => {
    onImmersiveChange?.(immersive)
  }, [immersive, onImmersiveChange])
  useEffect(() => () => onImmersiveChange?.(false), [onImmersiveChange])

  // Leaving a chat that never got a DB id (nothing was sent) drops its tab, so
  // tapping New and backing out doesn't leave an empty "Chat" row in the list.
  // A typed-but-unsent draft keeps it, like any other draft.
  const discardIfUnused = (tabId: string) => {
    const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId)
    if (!tab || tab.type !== "chat" || tab.chatId !== undefined) return
    if (getChatDraft(tabId).trim()) return
    closeTab(tabId)
  }
  const leaveChat = () => {
    if (openId) discardIfUnused(openId)
    setOpenId(null)
  }
  // Same when the screen goes away with the chat open (switching bottom tabs):
  // the open chat isn't restored, so the empty tab would land in the list.
  const openIdRef = useRef(openId)
  openIdRef.current = openId
  const discardRef = useRef(discardIfUnused)
  discardRef.current = discardIfUnused
  useEffect(() => () => {
    if (openIdRef.current) discardRef.current(openIdRef.current)
  }, [])

  // Android back leaves the conversation instead of the app.
  useBackHandler(immersive, leaveChat)

  // Inbox deep-link: open the target chat's conversation directly (mirrors
  // openHistory). ChatPanel loads the transcript from the DB chat id. One-shot —
  // clears the pending link so re-tapping the same notification works again.
  useEffect(() => {
    if (openChatId == null) return
    const tabId = openChatTab(`chat:${openChatId}`, openChatTitle || "Chat", undefined, undefined, openChatSubAgent || undefined)
    setTabChatId(tabId, openChatId)
    setActiveTab(tabId)
    setOpenId(tabId)
    onDeepLinkConsumed?.()
  }, [openChatId, openChatTitle, openChatSubAgent, openChatTab, setTabChatId, setActiveTab, onDeepLinkConsumed])

  // The native sheet needs the list before it opens. Use whatever is cached,
  // even if stale (the agent list rarely changes), and refresh it in the
  // background for next time; only a cold cache waits for the request.
  const loadProviders = async (): Promise<Provider[]> => {
    const toRows = (list: { id: string; label: string }[]) => list.map((p) => ({ id: p.id, label: p.label }))
    const cached = queryClient.getQueryData(providersQuery.queryKey)
    if (cached) {
      void queryClient.prefetchQuery(providersQuery)
      return toRows(cached)
    }
    try {
      return toRows(await queryClient.fetchQuery(providersQuery))
    } catch {
      // Leave the picker empty; the user can retry by reopening it.
      return []
    }
  }

  const openPicker = async () => {
    // Packaged apps: a system sheet (AgentSheet.swift / AgentSheet.kt) with
    // the same rows; the web sheet stays for the browser and as the fallback.
    if (hasNativeTabBar()) {
      const list = await loadProviders()
      try {
        await NativeShell.presentAgentSheet({
          title: intl.formatMessage({ id: "mobile.chats.newChat", defaultMessage: "New chat" }),
          emptyText: intl.formatMessage({ id: "mobile.chats.loadingAgents", defaultMessage: "Loading agents…" }),
          agents: list.map((p) => ({ id: p.id, label: p.label, logo: providerLogoName(p.id) ?? undefined })),
        })
        return
      } catch {
        // fall through to the web sheet
      }
    }
    // The web sheet reads the list from `useProviders` above.
    setPickerOpen(true)
  }

  useEffect(() => {
    if (!hasNativeTabBar()) return
    const handle = NativeShell.addListener("agentPicked", ({ id }) => startChat(id))
    return () => {
      void handle.then((h) => h.remove()).catch(() => {})
    }
    // startChat only closes over stable store actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startChat = (providerId: string) => {
    const id = createChatTab(providerId, "Chat")
    setActiveTab(id)
    setOpenId(id)
    setPickerOpen(false)
  }

  const openChat = (id: string) => {
    setActiveTab(id)
    setOpenId(id)
  }

  // Reopen a persisted conversation: create/focus its tab and hand the DB chat
  // id to ChatPanel, which loads the transcript via `chatHistoryGet`. Mirrors
  // the desktop chat-history dropdown (EditorTabs).
  //
  // Follow the tab id `openChatTab` hands back, not `chat:<dbId>`: a chat started
  // in this session already has a tab under a random id, and openChatTab reuses
  // it. Trusting the requested id left `openId` pointing at a tab that does not
  // exist, so tapping the conversation you had just been in did nothing while
  // every other row opened fine.
  const openHistory = (item: ChatHistoryItem) => {
    const isSubAgent = item.tp === "subagent" || item.tp === "workflow-agent"
    const tabId = openChatTab(`chat:${item.id}`, item.title, undefined, item.providerId ?? undefined, isSubAgent || undefined)
    setTabChatId(tabId, item.id)
    setActiveTab(tabId)
    setOpenId(tabId)
  }

  // Conversation view is deliberately chrome-less: the shell's context bar and
  // tab bar are hidden (see onImmersiveChange) and there is no header row at all
  // — the back affordance floats over the transcript so it costs zero layout
  // height, leaving the whole screen to the conversation. No safe-area insets
  // here: the transcript runs from edge to edge, under the status bar and the
  // floating back button at the top and under the floating composer at the
  // bottom, which clears the home indicator (or the keyboard) itself (ChatPanel).
  if (openTab) {
    const floatingButton =
      "absolute z-30 grid size-9 place-items-center rounded-full border border-border/50 bg-background/70 text-muted-foreground active:bg-muted/60"
    return (
      <div className="relative flex h-full flex-col">
        {/* Dim, don't cover: the transcript stays visible under the status
            bar (as in ChatGPT), just pressed towards the page color so the
            clock and the floating back button read over it. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-20"
          style={{
            height: "calc(env(safe-area-inset-top) + 2.5rem)",
            background:
              "linear-gradient(to bottom, color-mix(in srgb, var(--color-background) 82%, transparent) 0%, color-mix(in srgb, var(--color-background) 55%, transparent) env(safe-area-inset-top), transparent 100%)",
          }}
        />
        {/* In the packaged apps the back button is the native top bar's (see
            MobileApp / NativeShell); it reaches us through the back-handler
            stack registered above. */}
        {!hasNativeTabBar() && (
        <button
          type="button"
          onClick={leaveChat}
          aria-label={intl.formatMessage({ id: "common.back", defaultMessage: "Back" })}
          // Same translucent treatment as the metrics pills above the composer:
          // `bg-background/70`, no backdrop blur, so every floating control in
          // the conversation reads the same way over the transcript.
          className={cn(floatingButton, "left-2")}
          style={{ top: "calc(env(safe-area-inset-top) + 0.25rem)" }}
        >
          <ArrowLeft className="size-5" />
        </button>
        )}
        {/* Its partner on the right: the Session panel, which holds the context
            and quota read-outs too. The apps put this in the native bar. */}
        {!hasNativeTabBar() && sessionPanelOffered && (
        <button
          type="button"
          onClick={() => setSessionPanelOpen(true)}
          aria-label={intl.formatMessage({ id: "editor.agentPanel.open", defaultMessage: "Session panel" })}
          className={cn(floatingButton, "right-2")}
          style={{ top: "calc(env(safe-area-inset-top) + 0.25rem)" }}
        >
          <Activity className="size-[18px]" />
        </button>
        )}
        <div className="min-h-0 flex-1">
          <ChatPanel chatId={openTab.id} providerId={openTab.providerId} mobileKeyboardOpen={keyboardOpen} />
        </div>
      </div>
    )
  }

  const isEmpty = specId == null && !loading && liveTabs.length === 0 && history.length === 0

  // Pull to refresh: the spec's chats come from the spec view, everything else
  // from the workspace's chat history.
  const refreshList = () =>
    specId != null
      ? queryClient.refetchQueries({ queryKey: specKeys.view(specId) })
      : refreshHistory()

  return (
    <div className="flex h-full flex-col">
      <MobileHeader
        actions={specId != null ? [] : [{
          id: "new",
          label: intl.formatMessage({ id: "common.new", defaultMessage: "New" }),
          icon: <SquarePen className="size-[18px]" />,
          symbol: "square.and.pencil",
          onClick: openPicker,
        }]}
      />

      {isEmpty ? (
        <PullToRefresh onRefresh={refreshList} indicatorTop={contentOffset}>
          <EmptyChats onNew={openPicker} topOffset={contentOffset} />
        </PullToRefresh>
      ) : (
        <PullToRefresh
          onRefresh={refreshList}
          indicatorTop={contentOffset}
          className="p-2"
          style={{ paddingTop: `calc(${contentOffset} + 0.5rem)`, paddingBottom: `calc(${contentBottom} + 0.5rem)` }}
          onScroll={handleScroll}
        >
          {specId != null ? <MobileSpecChatsList key={specId} specId={specId} onOpenChat={onOpenSpecChat} /> : <>
          {liveTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => openChat(tab.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-row-hover"
              )}
            >
              <AgentAvatar provider={tab.providerId} size="sm" />
              <span className="truncate text-base text-foreground/85">{tab.title}</span>
              {tab.chatId != null && runningChatIds.has(tab.chatId) && (
                <Loader2 className="ml-auto size-4 shrink-0 animate-spin text-status-info" aria-label="Running" />
              )}
            </button>
          ))}

          {history.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => openHistory(item)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-row-hover"
              )}
            >
              <AgentAvatar provider={item.providerId} size="sm" />
              <span className="truncate text-base text-foreground/85">{item.title}</span>
              {runningChatIds.has(item.id) ? (
                <Loader2 className="ml-auto size-4 shrink-0 animate-spin text-status-info" aria-label="Running" />
              ) : (
                <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground/60">
                  {formatRelativeTime(intl, item.updatedAt)}
                </span>
              )}
            </button>
          ))}

          {loadingMore && (
            <div className="flex items-center justify-center gap-2 py-4 text-[13px] text-muted-foreground/60">
              <Loader2 className="size-3.5 animate-spin" />
              <FormattedMessage id="mobile.chats.loading" defaultMessage="Loading…" />
            </div>
          )}

          {loading && history.length === 0 && liveTabs.length === 0 && (
            <>
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-3" style={{ opacity: 1 - i * 0.1 }}>
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-3 w-10 shrink-0" />
                </div>
              ))}
            </>
          )}
          </>}
        </PullToRefresh>
      )}

      <MobileSheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={intl.formatMessage({ id: "mobile.chats.newChat", defaultMessage: "New chat" })}
      >
        {providers.length === 0 ? (
          <p className="px-2 py-6 text-center text-base text-muted-foreground/70">
            <FormattedMessage id="mobile.chats.loadingAgents" defaultMessage="Loading agents…" />
          </p>
        ) : (
          <div className="space-y-0.5">
            {providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                onClick={() => startChat(provider.id)}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-3 text-left text-base text-foreground/85 hover:bg-row-hover"
              >
                <ProviderIcon id={provider.id} size={18} />
                {provider.label}
              </button>
            ))}
          </div>
        )}
      </MobileSheet>
    </div>
  )
}

function EmptyChats({ onNew, topOffset }: { onNew: () => void; topOffset: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center" style={{ paddingTop: topOffset }}>
      <div className="flex size-14 items-center justify-center rounded-xl border border-border/50 bg-muted/30">
        <MessageSquarePlus className="size-6 text-muted-foreground/70" />
      </div>
      <div className="space-y-1">
        <p className="text-base font-medium text-foreground/85">
          <FormattedMessage id="mobile.chats.emptyTitle" defaultMessage="No chats yet" />
        </p>
        <p className="text-[13px] text-muted-foreground/70">
          <FormattedMessage id="mobile.chats.emptyDesc" defaultMessage="Start a conversation with an agent." />
        </p>
      </div>
      <button
        type="button"
        onClick={onNew}
        className="rounded-lg border border-border/50 bg-muted/30 px-4 py-2 text-base font-medium text-foreground/85 hover:bg-row-hover"
      >
        <FormattedMessage id="mobile.chats.newChat" defaultMessage="New chat" />
      </button>
    </div>
  )
}
