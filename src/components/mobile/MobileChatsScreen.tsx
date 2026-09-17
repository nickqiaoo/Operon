import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, Loader2, MessageSquarePlus, Plus } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useChatHistoryList, type ChatHistoryListItem } from "@/lib/chat-queries"
import { Skeleton } from "@/components/ui/skeleton"
import { useEditorStore } from "@/stores/editor-store"
import { useBackHandler } from "@/hooks/useAndroidBackButton"
import { ChatPanel } from "@/components/editor/ChatPanel"
import { hasNativeTabBar, NativeShell } from "@/lib/native"
import { ProviderIcon, providerLogoName } from "@/components/editor/components/ModelSelectorPanel"
import { MobileSheet } from "./MobileSheet"

interface Provider {
  id: string
  label: string
}

type ChatHistoryItem = ChatHistoryListItem

interface MobileChatsScreenProps {
  keyboardOpen?: boolean
  /** Inbox deep-link: open this DB chat directly. Cleared via onDeepLinkConsumed. */
  openChatId?: number | null
  openChatTitle?: string
  onDeepLinkConsumed?: () => void
  /**
   * Reports whether a conversation is open, so the shell can drop its top
   * context bar and bottom tab bar and give the transcript the full screen.
   */
  onImmersiveChange?: (immersive: boolean) => void
}

/** Conversations fetched per request; more load as the list scrolls. */
const CHATS_PAGE_SIZE = 30

const formatRelativeTime = (timestamp: number): string => {
  const diffMin = Math.floor((Date.now() - timestamp) / 60000)
  if (diffMin < 1) return "just now"
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return `${Math.floor(diffDay / 30)}mo ago`
}

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
export function MobileChatsScreen({ keyboardOpen = false, openChatId, openChatTitle, onDeepLinkConsumed, onImmersiveChange }: MobileChatsScreenProps) {
  const intl = useIntl()
  const tabs = useEditorStore((s) => s.tabs)
  const currentWorkspaceId = useEditorStore((s) => s.currentWorkspaceId)
  const createChatTab = useEditorStore((s) => s.createChatTab)
  const openChatTab = useEditorStore((s) => s.openChatTab)
  const setTabChatId = useEditorStore((s) => s.setTabChatId)
  const setActiveTab = useEditorStore((s) => s.setActiveTab)

  const [openId, setOpenId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [providers, setProviders] = useState<Provider[]>([])

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
  } = useChatHistoryList({
    workspaceId: currentWorkspaceId,
    tp: "chat",
    pageSize: CHATS_PAGE_SIZE,
    enabled: openId === null,
    staleTime: 0,
  })

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!hasMore || loadingMore) return
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

  // Android back leaves the conversation instead of the app.
  useBackHandler(immersive, () => setOpenId(null))

  // Inbox deep-link: open the target chat's conversation directly (mirrors
  // openHistory). ChatPanel loads the transcript from the DB chat id. One-shot —
  // clears the pending link so re-tapping the same notification works again.
  useEffect(() => {
    if (openChatId == null) return
    const tabId = openChatTab(`chat:${openChatId}`, openChatTitle || "Chat")
    setTabChatId(tabId, openChatId)
    setActiveTab(tabId)
    setOpenId(tabId)
    onDeepLinkConsumed?.()
  }, [openChatId, openChatTitle, openChatTab, setTabChatId, setActiveTab, onDeepLinkConsumed])

  const loadProviders = async (): Promise<Provider[]> => {
    if (providers.length > 0) return providers
    try {
      const list = (await api.getProviders()).map((p) => ({ id: p.id, label: p.label }))
      setProviders(list)
      return list
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
    setPickerOpen(true)
    void loadProviders()
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
    const tabId = openChatTab(`chat:${item.id}`, item.title, undefined, item.providerId ?? undefined)
    setTabChatId(tabId, item.id)
    setActiveTab(tabId)
    setOpenId(tabId)
  }

  // Conversation view is deliberately chrome-less: the shell's context bar and
  // tab bar are hidden (see onImmersiveChange) and there is no header row at all
  // — the back affordance floats over the transcript so it costs zero layout
  // height, leaving the whole screen to the conversation. Both safe-area insets
  // move here since the bars that used to carry them are gone; the bottom one is
  // dropped while the keyboard is up, where the composer is fixed above the
  // keyboard and the inset no longer applies.
  if (openTab) {
    return (
      <div
        className="relative flex h-full flex-col"
        style={{
          // No top inset here on purpose: the transcript itself pads its first
          // message below the status bar and the floating back button, so the
          // conversation scrolls *under* both (ChatPanel's ConversationContent).
          paddingBottom: keyboardOpen ? undefined : "env(safe-area-inset-bottom)",
        }}
      >
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
          onClick={() => setOpenId(null)}
          aria-label={intl.formatMessage({ id: "common.back", defaultMessage: "Back" })}
          // Same translucent treatment as the metrics pills above the composer:
          // `bg-background/70`, no backdrop blur, so every floating control in
          // the conversation reads the same way over the transcript.
          className="absolute left-2 z-30 grid size-9 place-items-center rounded-full border border-border/50 bg-background/70 text-muted-foreground active:bg-muted/60"
          style={{ top: "calc(env(safe-area-inset-top) + 0.25rem)" }}
        >
          <ArrowLeft className="size-5" />
        </button>
        )}
        <div className="min-h-0 flex-1">
          <ChatPanel chatId={openTab.id} providerId={openTab.providerId} mobileKeyboardOpen={keyboardOpen} />
        </div>
      </div>
    )
  }

  const isEmpty = !loading && liveTabs.length === 0 && history.length === 0

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/50 px-4">
        <span className="text-base font-semibold text-foreground/90">
          <FormattedMessage id="mobile.chats.title" defaultMessage="Chats" />
        </span>
        <button
          type="button"
          onClick={openPicker}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <Plus className="size-4" />
          <FormattedMessage id="common.new" defaultMessage="New" />
        </button>
      </div>

      {isEmpty ? (
        <EmptyChats onNew={openPicker} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2" onScroll={handleScroll}>
          {liveTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => openChat(tab.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-muted/40"
              )}
            >
              <ProviderIcon id={tab.providerId ?? ""} size={16} />
              <span className="truncate text-base text-foreground/85">{tab.title}</span>
            </button>
          ))}

          {history.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => openHistory(item)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-muted/40"
              )}
            >
              <ProviderIcon id={item.providerId ?? ""} size={16} />
              <span className="truncate text-base text-foreground/85">{item.title}</span>
              <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground/60">
                {formatRelativeTime(item.updatedAt)}
              </span>
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
        </div>
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
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-3 text-left text-base text-foreground/85 hover:bg-muted/40"
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

function EmptyChats({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
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
        className="rounded-lg border border-border/50 bg-muted/30 px-4 py-2 text-base font-medium text-foreground/85 hover:bg-muted/50"
      >
        <FormattedMessage id="mobile.chats.newChat" defaultMessage="New chat" />
      </button>
    </div>
  )
}
