import { useEffect } from "react"
import { ChatPanel } from "@/components/editor/ChatPanel"
import { useEditorStore } from "@/stores/editor-store"

interface SideChatTabProps {
  /** Chat row backing this side chat. */
  chatId: number
  /** Conversation it branched off. */
  parentChatId: number
  isActive: boolean
}

/**
 * Renders a side chat in the right panel by mounting the ordinary
 * {@link ChatPanel} against its chat row — a side chat is a normal conversation
 * as far as the UI is concerned, it just started life as a fork.
 *
 * ChatPanel resolves its state through the editor store, so this makes sure the
 * side chat is registered there before mounting. `@/lib/side-chat` already does
 * that when opening the tab; doing it again here covers the tab surviving a
 * reload, where the panel tab is restored but the editor store starts empty.
 */
export function SideChatTab({ chatId, isActive }: SideChatTabProps) {
  const openSideChatTab = useEditorStore((s) => s.openSideChatTab)
  const editorTabId = `chat:${chatId}`
  // `providerId` has to come from the store rather than be passed once: ChatPanel
  // drives its model list off this prop, and useChatHistory corrects the tab's
  // provider after loading the row. Reading it live is what closes that loop —
  // without it the panel never resolves a model and the composer stays disabled.
  const providerId = useEditorStore(
    (s) => s.tabs.find((tab) => tab.id === editorTabId)?.providerId
  )

  useEffect(() => {
    openSideChatTab(chatId, "Side chat")
  }, [chatId, openSideChatTab])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatPanel chatId={editorTabId} providerId={providerId} visible={isActive} />
    </div>
  )
}
