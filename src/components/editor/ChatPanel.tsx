'use client';

import { toast } from 'sonner';
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import type { FileUIPart } from 'ai';
import { ChartPie, Gauge } from 'lucide-react';
import { AgentPanel, SESSION_PANEL_PAD_CLASS, type SessionUsageCard } from './agent/AgentPanel';
import { skillsList, type OperonSkillDTO } from './agent/agentControl';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { buildChatNavigatorEntries, ChatNavigator } from './components/ChatNavigator';
import { nativeTopBarTakesSpace } from '@/lib/native';
import { useConversationScroll } from '@/components/ai-elements/conversation';
import {
  PromptInputProvider,
  usePromptInputController,
} from '@/components/ai-elements/prompt-input';
import { api } from '@/lib/api';
import { useEditorStore } from '@/stores/editor-store';
import { useExternalAgentsStore } from '@/stores/external-agents-store';
import { useStreamingStore } from '@/stores/streaming-store';
import {
  Context,
  ContextContent,
  ContextDetailedContent,
  ContextTrigger,
} from '@/components/ai-elements/context';
import { MobileContextUsage } from './components/MobileContextUsage';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useModelManagement, type SlashCommandItem } from './hooks/useModelManagement';
import { useChatHistory } from './hooks/useChatHistory';
import { normalizeHistoryMessages } from './hooks/useChatHistory';
import { mergeServerTail, TAIL_SYNC_SIZE } from './utils/merge-server-tail';
import { useAttachmentLoader } from './hooks/useAttachmentLoader';
import { AnnotationTray, annotationToFiles } from './AnnotationTray';
import { SelectionToolbar, type SelectionAction } from '@/components/ui/selection-toolbar';
import { openSideChat } from '@/lib/side-chat';
import { useProviderCapabilityStore } from '@/stores/provider-capability-store';
import { useAnnotationsStore, annotationsForWorkspace } from '@/stores/annotations-store';
import { LineCommentTray } from './comments/LineCommentTray';
import { SelectedTextTray } from './comments/SelectedTextTray';
import {
  useSelectedTextStore,
  selectedTextForChat,
  selectedTextToFile,
} from '@/stores/selected-text-store';
import {
  useLineCommentsStore,
  lineCommentsForWorkspace,
  lineCommentToFile,
} from '@/stores/line-comments-store';
import { useAnnotationSendStore } from '@/stores/annotation-send-store';
import { useChatActions } from './hooks/useChatActions';
import { useRecentDerivedState } from './hooks/useRecentDerivedState';
import { extractContextCompaction, extractContextUsage } from './utils/chatMetadata';
import { useChatIndexState } from './hooks/useChatIndexState';
import { useRewindController } from './hooks/useRewindController';
import { useChatPanelEffects } from './hooks/useChatPanelEffects';
import { useSendToModels } from './hooks/useSendToModels';
import { useChatRuntime } from './hooks/useChatRuntime';
import { useClaudeUsagePolling } from './hooks/useClaudeUsagePolling';
import { useCacheExpiryNotice } from './hooks/useCacheExpiryNotice';
import { useChatSessionControls } from './hooks/useChatSessionControls';
import { MessagesList } from './components/MessagesList';
import { ChatDbIdContext } from './components/chat-db-id-context';
import type { TurnDiffFile } from './components/TurnDiffCard';
import { ChatInputArea } from './components/ChatInputArea';
import { SteerTray } from './components/SteerTray';
import {
  findLatestTurnMessageId,
  getInjectedInput,
  isSteerUserMessage,
  type LiveSteerItem,
} from './components/steer-message';
import { GoalBanner } from './components/GoalBanner';
import { useGoal } from './hooks/useGoal';
import { useProjectStore } from '@/stores/project-store';
import { useTabsStore } from '@/stores/tabs-store';
import { useReviewTurnStore } from '@/stores/review-turn-store';
import { useAppShellStore } from '@/stores/app-shell-store';
import { WorkflowApprovalsBar } from './components/WorkflowRunsWatcher';
import { SpecChatBar } from '@/components/spec/SpecChatBar';
import { RewindConfirmDialog, RewindConflictDialog } from './components/RewindConfirmDialog';
import { TodoQueue, extractTodosFromPart, isTodoWriteTool } from './components/TodoWriteRenderer';
import { CanvasChatBanner } from './components/CanvasChatBanner';
import { isCanvasChatId } from '@/lib/canvas-utils';
import { trackEvent } from '@/lib/analytics';
import { ChatWaitingIndicator } from './components/ChatWaitingIndicator';
import { CodexRateLimitsDetails } from './components/CodexRateLimitsButton';
import { ClaudeRateLimitsDetails } from './components/ClaudeRateLimitsButton';
import { useChatNotifications } from '@/hooks/useNotification';
import { useVisibleChatInboxRead } from '@/hooks/useVisibleChatInboxRead';
import { cn } from '@/lib/utils';
import { usePageVisible } from '@/lib/page-visibility';
import { useChatReadOnlyReason } from '@/lib/chat-read-only';
import { useSessionPanelStore } from '@/stores/session-panel-store';
import { MobileSheet } from '@/components/mobile/MobileSheet';
import {
  getRecentChatOptions,
  updateRecentChatOptions,
  type RecentChatOptions,
} from './recentChatOptions';

const MobileTurnDiffReview = lazy(() =>
  import('@/components/mobile/MobileTurnDiffReview').then((module) => ({
    default: module.MobileTurnDiffReview,
  }))
);

interface ChatPanelProps {
  chatId: string;
  providerId?: string;
  mobileKeyboardOpen?: boolean;
  visible?: boolean;
}

export const ChatPanel = memo(function ChatPanel(props: ChatPanelProps) {
  const pageVisible = usePageVisible();
  return (
    <PromptInputProvider>
      <ChatPanelContent {...props} visible={props.visible !== false && pageVisible} />
    </PromptInputProvider>
  );
});

function ChatPanelContent({
  chatId,
  providerId,
  mobileKeyboardOpen = false,
  visible = true,
}: ChatPanelProps) {
  const intl = useIntl();
  const { textInput: { value: input, setInput: setInputState }, attachments } = usePromptInputController();
  const setInput = (val: string) => setInputState(val);

  const [selectorOpen, setSelectorOpen] = useState(false);
  /** Skill chosen in the session panel, handed to the composer as a chip on the next render. */
  const [pendingSkill, setPendingSkill] = useState<SlashCommandItem | null>(null);
  const isMobile = useIsMobile();
  // Phone: the composer floats over the transcript, so the transcript pads its
  // end by the composer's live height (it grows with the text, a queued steer,
  // an error line) rather than stopping above it.
  // The metrics pills float just above it (outside its box), so they count too:
  // the last message and the scroll-down button both have to clear them.
  // Written straight to a CSS variable on the root, not React state: the composer
  // animates its height, and a re-render of this whole panel per frame left the
  // scroll-down button trailing behind it.
  const composerRef = useRef<HTMLDivElement>(null);
  const pillsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = composerRef.current;
    const pills = pillsRef.current;
    const root = transcriptRef.current;
    if (!isMobile || !el || !root) return;
    const PILLS_GAP = 4; // the pills row's `mb-1`
    const measure = () => {
      const pillsHeight = pills && pills.offsetHeight > 0 ? pills.offsetHeight + PILLS_GAP : 0;
      root.style.setProperty("--composer-height", `${el.offsetHeight + pillsHeight}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (pills) observer.observe(pills);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--composer-height");
    };
  }, [isMobile]);
  const currentWorkspaceId = useEditorStore((state) => {
    if (state.tabs.some((tab) => tab.id === chatId)) return state.currentWorkspaceId;
    for (const [workspaceId, workspace] of Object.entries(state.workspaceStates)) {
      if (workspace.tabs.some((tab) => tab.id === chatId)) return workspaceId === 'global' ? null : Number(workspaceId);
    }
    return null;
  });
  const pendingAnnotationCount = useAnnotationsStore(
    (state) => annotationsForWorkspace(state.items, currentWorkspaceId).length,
  );
  const pendingLineCommentCount = useLineCommentsStore(
    (state) => lineCommentsForWorkspace(state.items, currentWorkspaceId).length,
  );
  const updateTabTitle = useEditorStore((state) => state.updateTabTitle);
  const updateTabProvider = useEditorStore((state) => state.updateTabProvider);
  const openChatTab = useEditorStore((state) => state.openChatTab);
  const clearTabInputAttachment = useEditorStore((state) => state.clearTabInputAttachment);
  const setTabChatId = useEditorStore((state) => state.setTabChatId);

  const tab = useEditorStore((state) => {
    // Search current workspace tabs first
    const foundTab = state.tabs.find((t) => t.id === chatId);
    if (foundTab) return foundTab;
    // Also search inactive workspace tabs (kept alive across workspace switches)
    for (const wsState of Object.values(state.workspaceStates)) {
      const wsTab = wsState.tabs.find((t) => t.id === chatId);
      if (wsTab) return wsTab;
    }
    return undefined;
  });
  const dbChatId = tab?.chatId;
  const readOnlyReason = useChatReadOnlyReason(dbChatId);

  // Selection toolbar over the transcript. The container is the whole panel and
  // the targetSelector is what actually narrows it to assistant messages, so a
  // selection in the composer or in a user's own message raises nothing.
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  // The transcript reserves a scrollbar gutter on both edges (see
  // ConversationContent below), so once the panel is narrower than max-w-4xl
  // its column is one gutter narrower on each side than the composer's. Publish
  // that gutter as a CSS variable so the composer can shrink by the same amount.
  // Measured rather than hard-coded: it is 11px with classic scrollbars and 0
  // with overlay ones.
  useLayoutEffect(() => {
    const root = transcriptRef.current;
    const scroller = root?.querySelector<HTMLElement>('[data-conversation-scroller]');
    if (!root || !scroller) return;
    const update = () => {
      const gutter = (scroller.offsetWidth - scroller.clientWidth) / 2;
      root.style.setProperty('--transcript-gutter', `${gutter}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);
  const sideChatProviderId = tab?.providerId ?? providerId;
  const canOpenSideChat = useProviderCapabilityStore(
    (state) =>
      sideChatProviderId != null &&
      state.byProvider[sideChatProviderId]?.sideChat === true
  );
  const selectionActions = useMemo<SelectionAction[]>(() => {
    const actions: SelectionAction[] = [
      {
        key: 'add-to-chat',
        label: <FormattedMessage id="selection.addToChat" defaultMessage="Add to chat" />,
        // Bound to this chat: a quote pulled out of this transcript belongs to
        // this conversation, not to whatever else the workspace has open.
        onSelect: ({ text }) => {
          useSelectedTextStore.getState().add({
            id: crypto.randomUUID(),
            workspaceId: currentWorkspaceId,
            chatId: dbChatId,
            text,
            createdAt: Date.now(),
          });
        },
      },
    ];
    // A side chat branches the conversation it is opened from, so there has to be
    // one on disk, and a side chat cannot branch again.
    if (canOpenSideChat && dbChatId != null && tab?.isSideChat !== true) {
      actions.push({
        key: 'ask-in-side-chat',
        label: <FormattedMessage id="selection.askInSideChat" defaultMessage="Ask in side chat" />,
        onSelect: ({ text }) => {
          void openSideChat(dbChatId, { providerId: sideChatProviderId })
            .then((sideChatId) => {
              if (sideChatId == null) return;
              // Bound to the new side chat, so it rides along there rather than
              // showing up on the parent's composer.
              useSelectedTextStore.getState().add({
                id: crypto.randomUUID(),
                workspaceId: currentWorkspaceId,
                chatId: sideChatId,
                text,
                createdAt: Date.now(),
              });
            })
            .catch((error) => {
              console.error('[ChatPanel] Failed to open side chat from selection:', error);
            });
        },
      });
    }
    return actions;
  }, [canOpenSideChat, currentWorkspaceId, dbChatId, sideChatProviderId, tab?.isSideChat]);
  useVisibleChatInboxRead(dbChatId, visible);
  const [recentOptionsState] = useState(() => {
    const remember =
      tab?.isSubAgent !== true &&
      tab?.options?.autoRun !== true;
    const restore = remember && tab?.chatId === undefined;
    return {
      remember,
      options: restore ? getRecentChatOptions(providerId) : {},
    };
  });
  const [thinkingEffort, setThinkingEffort] = useState(
    () => recentOptionsState.options.thinkingEffort ?? 'high',
  );
  const rememberRecentOptions = useCallback((patch: RecentChatOptions) => {
    if (!recentOptionsState.remember) return;
    updateRecentChatOptions(providerId, patch);
  }, [providerId, recentOptionsState.remember]);

  const appliedTabInputKeyRef = useRef<string | null>(null);

  const modelManagement = useModelManagement(
    tab?.options?.modelId ?? recentOptionsState.options.modelId ?? '',
    providerId,
    { ...recentOptionsState.options, preserveModel: tab?.isSubAgent === true },
  );
  const {
    model, setModel, availableModels, selectedModel,
    modeOptions, currentMode, setMode, serviceTierOptions, currentServiceTier, toggleFastMode, thinkingEffortOptions,
    modeButtonClass, cycleMode, slashCommands, supportsInjection, supportsGoal,
    supportsDynamicSwitch, supportsContextUsage,
  } = modelManagement;
  const { sendToAvailableModels, loadGlobalModels } = useSendToModels({
    providerId,
    availableModels,
  });

  const {
    historyDbChatId,
    dbChatIdRef,
    chatBodyRef,
    messages,
    status,
    chatError,
    sendMessage,
    stop,
    setMessages,
    addToolApprovalResponse,
    resumeOnAttach,
    liveTurnActive,
    isGenerating,
    turnSettling,
    canDynamicSwitch,
  } = useChatRuntime({
    chatId,
    dbChatId,
    providerId,
    selectedModelProviderId: selectedModel?.providerId,
    selectedModelId: selectedModel?.id,
    supportsDynamicSwitch,
    model,
    currentMode,
    forcedModeId: tab?.options?.modeId,
    currentServiceTier,
    thinkingEffort,
    thinkingEffortValues: thinkingEffortOptions.map((o) => o.value),
    currentWorkspaceId,
    autoRun: tab?.options?.autoRun,
    setTabChatId,
  });
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // One rail tick per prompt, with the reply's opening line for the hover card.
  const navigatorEntries = useMemo(() => buildChatNavigatorEntries(messages), [messages]);

  const setStreaming = useStreamingStore((s) => s.setStreaming);
  const clearUnseen = useStreamingStore((s) => s.clearUnseen);
  const isClaudeCode = providerId === 'claude-code' || selectedModel?.providerId === 'claude-code';
  // Quota pushed onto the live stream by `rate_limit_event`, which lands the
  // moment usage steps 1% instead of on the next poll.
  //
  // Only safe to read **while the message is still streaming**. Persisted rows
  // carry the same field frozen at the time of their turn — an earlier version
  // fell back to those and the badge jumped to a weeks-old number whenever the
  // poll had nothing yet. A streaming message cannot be stale, hence the
  // `isGenerating` gate; the hook folds this into the poll's cache so nothing
  // changes on screen when the turn ends and the push stops.
  const livePushedClaudeRateLimits = useMemo(() => {
    if (!isClaudeCode || !isGenerating) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== 'assistant') continue;
      return extractContextUsage(message)?.claudeRateLimits ?? null;
    }
    return null;
  }, [isClaudeCode, isGenerating, messages]);

  const {
    detailedContextUsage: polledContextUsage,
    claudeRateLimits: polledClaudeRateLimits,
  } = useClaudeUsagePolling({
    chatId: dbChatId,
    isClaudeCode,
    supportsContextUsage,
    isActive: visible,
    isGenerating,
    pushedRateLimits: livePushedClaudeRateLimits,
  });
  useEffect(() => {
    setStreaming(chatId, isGenerating);
    // All ChatPanels stay mounted across workspaces. Only clear the unseen
    // badge if this tab is the one the user is actually viewing.
    if (!isGenerating && visible) {
      clearUnseen([chatId]);
    }
    return () => setStreaming(chatId, false);
  }, [chatId, isGenerating, setStreaming, clearUnseen, visible]);

  useAttachmentLoader(tab?.options?.inputAttachment, chatId, attachments.add, clearTabInputAttachment);


  useLayoutEffect(() => {
    if (!tab?.options?.input) return;

    const inputKey = `${chatId}:${tab.options.timestamp ?? 'no-ts'}:${tab.options.input}`;
    if (appliedTabInputKeyRef.current === inputKey) return;

    appliedTabInputKeyRef.current = inputKey;
    setInput(tab.options.input);
  }, [chatId, setInput, tab?.options?.input, tab?.options?.timestamp]);

  const setThinkingEffortAndRemember = useCallback((nextEffort: string) => {
    if (!thinkingEffortOptions.some((option) => option.value === nextEffort)) return;
    setThinkingEffort(nextEffort);
    rememberRecentOptions({ thinkingEffort: nextEffort });
    if (canDynamicSwitch && tab?.isSubAgent !== true && dbChatIdRef.current) {
      void api.aiCCDynamicSet({ chatId: dbChatIdRef.current, thinkingLevel: nextEffort });
    }
  }, [canDynamicSwitch, dbChatIdRef, rememberRecentOptions, tab?.isSubAgent, thinkingEffortOptions]);

  const cycleThinkingEffort = useCallback(() => {
    const idx = thinkingEffortOptions.findIndex((option) => option.value === thinkingEffort);
    const next = thinkingEffortOptions[(idx + 1) % thinkingEffortOptions.length];
    if (next) setThinkingEffortAndRemember(next.value);
  }, [thinkingEffortOptions, thinkingEffort, setThinkingEffortAndRemember]);

  useEffect(() => {
    if (!thinkingEffortOptions.length) return;
    if (thinkingEffortOptions.some((option) => option.value === thinkingEffort)) return;
    setThinkingEffort(thinkingEffortOptions[0].value);
  }, [thinkingEffortOptions, thinkingEffort]);

  useEffect(() => {
    if (selectedModel) updateTabProvider(chatId, selectedModel.provider);
  }, [chatId, selectedModel?.provider, updateTabProvider]);

  const setModeAndRemember = useCallback((nextMode: string) => {
    setMode(nextMode);
    rememberRecentOptions({ modeId: nextMode });
  }, [rememberRecentOptions, setMode]);

  const cycleModeAndRemember = useCallback(() => {
    if (!modeOptions.length) {
      cycleMode();
      return;
    }
    const currentIndex = modeOptions.findIndex((option) => option.value === currentMode);
    const nextMode = modeOptions[(currentIndex + 1) % modeOptions.length];
    cycleMode();
    if (nextMode) rememberRecentOptions({ modeId: nextMode.value });
  }, [currentMode, cycleMode, modeOptions, rememberRecentOptions]);

  const {
    handlePermissionDecide,
    handleSetModel,
    handleSetMode,
    handleCycleMode,
  } = useChatSessionControls({
    providerId,
    selectedModelProviderId: selectedModel?.providerId,
    addToolApprovalResponse,
    currentTabChatId: tab?.chatId,
    currentDbChatId: dbChatIdRef.current,
    setMode: setModeAndRemember,
    sendMessage,
    chatBodyRef,
    setModel,
    canDynamicSwitch: canDynamicSwitch && tab?.isSubAgent !== true,
    cycleMode: cycleModeAndRemember,
    modeOptions,
    currentMode,
  });

  const handleSetModelAndRemember = useCallback((modelId: string) => {
    rememberRecentOptions({ modelId });
    handleSetModel(modelId);
  }, [handleSetModel, rememberRecentOptions]);

  const handleToggleFastMode = useCallback(() => {
    const fallbackServiceTier =
      serviceTierOptions.find((option) => option.value !== 'fast')?.value ?? '';
    const nextServiceTier = currentServiceTier === 'fast' ? fallbackServiceTier : 'fast';
    rememberRecentOptions({ serviceTier: nextServiceTier });
    toggleFastMode();
    if (canDynamicSwitch && tab?.isSubAgent !== true && dbChatIdRef.current) {
      void api.aiCCDynamicSet({ chatId: dbChatIdRef.current, serviceTier: nextServiceTier });
    }
  }, [
    canDynamicSwitch,
    currentServiceTier,
    dbChatIdRef,
    rememberRecentOptions,
    serviceTierOptions,
    tab?.isSubAgent,
    toggleFastMode,
  ]);

  useChatNotifications(status, messages, {
    modelLabel: selectedModel?.label,
    providerGroup: selectedModel?.group,
  });

  const { historyLoaded, loadedModel, loadedProviderId, loadedThinkingLevel, loadedUpdatedAt, hasMore: chatHasMore, loadingMore: chatLoadingMore, loadMore: chatLoadMore } = useChatHistory(historyDbChatId, setMessages, tab?.options?.timestamp);

  // Sits below useChatHistory because it needs that hook's loaded timestamp to
  // date a conversation reopened from history.
  const { showCacheExpiredNotice, dismissCacheExpiredNotice } = useCacheExpiryNotice({
    enabled: isClaudeCode,
    isGenerating,
    lastMessageAt: loadedUpdatedAt,
  });

  // Once initial history settles, release any live-status turn that arrived
  // during the load, or use the trailing persisted user message as a fallback
  // signal that this surface should rejoin the node's live-turn buffer.
  useEffect(() => {
    if (historyLoaded) resumeOnAttach();
  }, [historyLoaded, historyDbChatId, resumeOnAttach]);
  const {
    firstUserTitle,
    compactedInfo,
    latestTodos,
    contextUsage,
    codexUsageDetails,
  } = useRecentDerivedState({
    chatId,
    messages,
    historyLoaded,
    isTodoWriteTool,
    extractTodosFromPart,
  });
  const displayedContextUsage = useMemo(() => polledContextUsage
    ? {
        usage: contextUsage?.usage,
        maxTokens: polledContextUsage.maxTokens,
        usedTokens: polledContextUsage.totalTokens,
        detailedContextUsage: polledContextUsage,
      }
    : contextUsage, [polledContextUsage, contextUsage]);
  // The object exists long before it holds anything, and some agents never fill
  // it at all — Antigravity's ACP server sends no usage on any message, so the
  // badge sat there claiming a confident "0 tokens". Show it once there is a
  // real number to show; a provider that reports nothing gets no badge rather
  // than a wrong one.
  const hasContextUsageData =
    !!displayedContextUsage &&
    ((displayedContextUsage.maxTokens ?? 0) > 0 ||
      (displayedContextUsage.usedTokens ?? 0) > 0 ||
      (displayedContextUsage.usage?.inputTokens ?? 0) > 0 ||
      (displayedContextUsage.usage?.outputTokens ?? 0) > 0);
  // One source on screen: the poll's cache, which the push above is folded into.
  const displayedClaudeRateLimits = isClaudeCode ? polledClaudeRateLimits : null;
  const showCodexRateLimits = (providerId === 'codex' || selectedModel?.providerId === 'codex') && !!codexUsageDetails;
  const showContextUsage = !!displayedContextUsage && hasContextUsageData;

  const {
    externalAgentNotificationsByTaskId,
  } = useChatIndexState({
    chatId,
    messages,
    historyLoaded,
  });

  const [compactDismissed, setCompactDismissed] = useState<string | null>(null);
  const [compactLoading, setCompactLoading] = useState(false);
  const contextCompaction = extractContextCompaction(messages[messages.length - 1]);
  const isCompacting = compactLoading || contextCompaction?.status === 'in_progress';
  // Operon skills surfaced into the composer's `/` menu (same slash-command flow
  // as built-ins). Lazily fetched the first time a slash command is started.
  const [operonSkillCommands, setOperonSkillCommands] = useState<SlashCommandItem[]>([]);
  const operonSkillsLoadedRef = useRef(false);
  const isOperonProvider = providerId === 'custom' || selectedModel?.providerId === 'custom';
  const isCodexProvider = providerId === 'codex' || selectedModel?.providerId === 'codex';
  const isOpencodeProvider = providerId === 'opencode' || selectedModel?.providerId === 'opencode';
  const isQoderProvider = providerId === 'qoder' || selectedModel?.providerId === 'qoder';
  const sessionPanelProviderId = isClaudeCode
    ? 'claude-code'
    : isOperonProvider
      ? 'custom'
      : isCodexProvider
        ? 'codex'
        : isOpencodeProvider
          ? 'opencode'
          : isQoderProvider
            ? 'qoder'
            : undefined;

  // The Session cards are toggled from the window's top bar (TopBarControls), which
  // only offers the button while the visible chat has claimed it.
  const sessionPanelOpen = useSessionPanelStore((s) => s.open);
  const setSessionPanelOpen = useSessionPanelStore((s) => s.setOpen);
  const agentPanelOpen = sessionPanelOpen && visible && sessionPanelProviderId != null;
  useEffect(() => {
    if (!visible || !sessionPanelProviderId) return;
    const { claim, release } = useSessionPanelStore.getState();
    claim(chatId);
    return () => release(chatId);
  }, [visible, sessionPanelProviderId, chatId]);

  // Where there is a Session panel, the context and quota read-outs live in it,
  // laid out in full, instead of as pills floating over the transcript — any fill
  // there covered the last message. It opens from the window's top bar (desktop)
  // or the conversation's native bar (phone). Only a provider without a panel
  // keeps its context pill; every quota-reporting provider has one.
  const metricsInSessionPanel = sessionPanelProviderId != null;
  // Memoized (with the facts and callbacks below) so the memo'd Session panel
  // skips the re-render every streamed chunk would otherwise give it.
  const sessionUsageCards = useMemo(() => {
  const cards: SessionUsageCard[] = [];
  if (metricsInSessionPanel) {
    if (showContextUsage && displayedContextUsage) {
      cards.push({
        key: 'context',
        icon: ChartPie,
        title: <FormattedMessage id="editor.context.title" defaultMessage="Context window" />,
        content: (
          <Context chatId={dbChatId} detailedContextUsage={displayedContextUsage.detailedContextUsage} maxTokens={displayedContextUsage.maxTokens} usage={displayedContextUsage.usage} usedTokens={displayedContextUsage.usedTokens}>
            <ContextDetailedContent className="p-0" />
          </Context>
        ),
      });
    }
    if (displayedClaudeRateLimits) {
      cards.push({
        key: 'claude-quota',
        icon: Gauge,
        title: <FormattedMessage id="editor.claude.title" defaultMessage="Subscription usage" />,
        content: <ClaudeRateLimitsDetails rateLimits={displayedClaudeRateLimits} />,
      });
    }
    if (showCodexRateLimits && codexUsageDetails) {
      cards.push({
        key: 'codex-quota',
        icon: Gauge,
        title: <FormattedMessage id="editor.codex.title" defaultMessage="Rate limits" />,
        content: <CodexRateLimitsDetails account={codexUsageDetails.account} rateLimits={codexUsageDetails.rateLimits} />,
      });
    }
  }
  return cards;
  }, [metricsInSessionPanel, showContextUsage, displayedContextUsage, dbChatId, displayedClaudeRateLimits, showCodexRateLimits, codexUsageDetails]);
  const closeSessionPanel = useCallback(() => setSessionPanelOpen(false), [setSessionPanelOpen]);
  // A skill picked in the panel arrives as a chip in the composer — the same state a
  // `/` pick produces — rather than as text or as a message sent on your behalf.
  const handleSessionPanelSkill = useCallback((skill: OperonSkillDTO) => {
    setPendingSkill({ type: 'skill', name: skill.name, description: skill.description });
    setSessionPanelOpen(false);
  }, [setSessionPanelOpen]);

  // Reset the skill cache when switching chats or away from operon.
  useEffect(() => {
    operonSkillsLoadedRef.current = false;
    setOperonSkillCommands([]);
  }, [chatId, isOperonProvider]);

  // Fetch the session's skills the first time the user starts a slash command so
  // they show up in the `/` menu. Sending one injects a `[skill:name]` marker
  // (existing chip flow) which operon expands into a skill-invocation hint.
  useEffect(() => {
    if (!isOperonProvider || operonSkillsLoadedRef.current || !input.startsWith('/')) return;
    const id = tab?.chatId ?? dbChatIdRef.current;
    if (id == null) return;
    operonSkillsLoadedRef.current = true;
    skillsList(id)
      .then((res) =>
        setOperonSkillCommands(
          res.skills.map((s) => ({ name: s.name, description: s.description, type: 'skill' as const })),
        ),
      )
      .catch(() => {
        operonSkillsLoadedRef.current = false;
      });
  }, [input, isOperonProvider, tab?.chatId]);

  const mergedSlashCommands = operonSkillCommands.length
    ? [...slashCommands, ...operonSkillCommands]
    : slashCommands;
  const [liveSteers, setLiveSteers] = useState<LiveSteerItem[]>([]);
  const steerPending = liveSteers.some((item) => item.status === 'sending');
  const showCompactBanner = compactedInfo && compactDismissed !== JSON.stringify(compactedInfo);
  const updateTabProviderId = useEditorStore((state) => state.updateTabProviderId);
  const {
    rewindDialogOpen,
    setRewindDialogOpen,
    rewindMode,
    rewindedCheckpoint,
    pendingConflicts,
    handleRewindToCheckpoint,
    confirmRewind,
    cancelRewind,
    confirmConflicts,
    dismissConflicts,
    handleUndoRewind,
  } = useRewindController({
    dbChatId,
  });

  // Per-turn file diffs, rendered as a card at the end of each turn that changed
  // files. Refetched once the turn settles so the new turn's card appears.
  const reviewCwd = useProjectStore((s) => s.projects.flatMap((project) => project.workspaces).find((workspace) => workspace.id === currentWorkspaceId)?.worktreePath ?? null);
  // thinkingEffortOptions is a fresh array each render; key on the label instead.
  const thinkingEffortLabel = thinkingEffortOptions.find((option) => option.value === thinkingEffort)?.label;
  const sessionFacts = useMemo(() => ({
    cwd: reviewCwd,
    model: selectedModel?.label,
    effort: thinkingEffortLabel,
  }), [reviewCwd, selectedModel?.label, thinkingEffortLabel]);
  const openTab = useTabsStore((s) => s.openTab);
  const setRightPanelOpen = useAppShellStore((s) => s.setRightPanelOpen);
  const [turnDiffs, setTurnDiffs] = useState<{
    turns: Array<{ messageUid: string; snapshotId: string; files: TurnDiffFile[]; overlapped?: boolean }>;
  } | null>(null);
  const [mobileReviewMessageUid, setMobileReviewMessageUid] = useState<string | null>(null);
  useEffect(() => {
    if (dbChatId === undefined || !reviewCwd) { setTurnDiffs(null); return; }
    if (status === 'streaming' || status === 'submitted') return; // wait until the turn settles
    // Local status alone is not enough. Reopening a chat remounts this panel with
    // a fresh 'ready' status while the node is still mid-turn, and resume takes a
    // moment to reattach — long enough to fetch and render the running turn's
    // card early. `liveTurnActive` is the node's answer: `null` means presence
    // has not reported yet, so nothing is known and the fetch waits.
    if (liveTurnActive !== false) return;
    let cancelled = false;
    void api.aiGetTurnDiffs(dbChatId, reviewCwd)
      .then((res) => { if (!cancelled) setTurnDiffs(res); })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [dbChatId, status, reviewCwd, liveTurnActive]);

  // Open (or focus) the Review tab and point it at the clicked turn.
  const handleReviewTurn = useCallback((messageUid: string) => {
    if (dbChatId === undefined || !reviewCwd) return;
    if (isMobile) {
      setMobileReviewMessageUid(messageUid);
      return;
    }
    useReviewTurnStore.getState().setTurnChat(reviewCwd, dbChatId, messageUid);
    openTab(
      'right',
      { tabId: `review:${reviewCwd}`, title: intl.formatMessage({ id: 'tab.review.label', defaultMessage: 'Review' }), isClosable: true, payload: { type: 'review', rootPath: reviewCwd } },
      { activate: true },
    );
    setRightPanelOpen(true); // reveal the right panel (openTab alone doesn't)
  }, [dbChatId, intl, isMobile, reviewCwd, openTab, setRightPanelOpen]);

  useEffect(() => {
    setMobileReviewMessageUid(null);
  }, [dbChatId, reviewCwd]);

  useEffect(() => { if (loadedModel) setModel(loadedModel); }, [loadedModel, setModel]);

  useEffect(() => { if (loadedThinkingLevel) setThinkingEffort(loadedThinkingLevel); }, [loadedThinkingLevel]);

  useEffect(() => {
    if (tab?.options?.modelId) setModel(tab.options.modelId);
  }, [tab?.options?.modelId, setModel]);

  // Keep the mode picker showing what a sub-agent tab actually runs in. The
  // request already forces this mode (`forcedModeId`), so this is purely so the
  // UI doesn't claim a different one; re-applied when `modeOptions` arrives
  // because the provider-config load resets mode state to the provider default.
  useEffect(() => {
    if (tab?.options?.modeId) setMode(tab.options.modeId);
  }, [tab?.options?.modeId, modeOptions, setMode]);

  useEffect(() => {
    if (loadedProviderId && providerId !== loadedProviderId) updateTabProviderId(chatId, loadedProviderId);
  }, [loadedProviderId, providerId, chatId, updateTabProviderId]);

  useChatPanelEffects({
    chatId,
    autoRun: tab?.options?.autoRun,
    input: tab?.options?.input,
    timestamp: tab?.options?.timestamp,
    historyLoaded,
    isGenerating,
    messagesLength: messages.length,
    sendMessage,
    setInput,
    // A sub-agent tab opens as "Agent: <task>"; its first message is the
    // parent's long dispatch prompt ("Work in /path… You are the PLANNER…"),
    // which made every child tab read the same.
    firstUserTitle: tab?.isSubAgent ? null : firstUserTitle,
    updateTabTitle,
  });

  const chatActions = useChatActions(sendMessage, openChatTab, selectedModel?.providerId ?? providerId);
  const { handleSubmit: submitMessage, handleSendTo, handleSendToTab } = chatActions;

  const [compactResult, setCompactResult] = useState<{ originalMessageCount?: number; newMessageCount?: number } | null>(null);
  const handleCompact = useCallback(async () => {
    const currentChatId = tab?.chatId ?? dbChatIdRef.current;
    if (!currentChatId || !model) return;
    setCompactLoading(true);
    setCompactResult(null);
    try {
      const result = await api.aiCompact({
        chatId: currentChatId,
        modelId: model,
        providerId: selectedModel?.providerId ?? providerId,
        workspaceId: currentWorkspaceId ?? undefined,
      });
      if (result.success) {
        setCompactResult({
          originalMessageCount: result.originalMessageCount,
          newMessageCount: result.newMessageCount,
        });
      } else {
        console.error('[Compact] Failed:', result.error);
      }
    } catch (err) {
      console.error('[Compact] Error:', err);
    } finally {
      setCompactLoading(false);
    }
  }, [tab?.chatId, dbChatIdRef, model, selectedModel?.providerId, providerId, currentWorkspaceId]);

  const handleSubmit = useCallback((message: { text: string; files: FileUIPart[] }) => {
    // Intercept /compact command only for custom provider (others handle it in their own stream)
    const currentProviderId = selectedModel?.providerId ?? providerId;
    if (message.text.trim() === '/compact' && currentProviderId === 'custom') {
      setInput('');
      void handleCompact();
      return;
    }
    // Fold this workspace's queued browser annotations into the outgoing message
    // (context markdown + screenshot), then clear them — sending consumes them,
    // which also drops their on-page pins via the store subscription.
    const annStore = useAnnotationsStore.getState();
    const annotations = annotationsForWorkspace(annStore.items, currentWorkspaceId);
    const annFiles = annotations.flatMap(annotationToFiles);
    // Fold this workspace's queued inline line comments (diff / file preview) in
    // as text context, then clear them — same one-shot consume as annotations.
    const lineStore = useLineCommentsStore.getState();
    const lineComments = lineCommentsForWorkspace(lineStore.items, currentWorkspaceId);
    const lineCommentFiles = lineComments.map(lineCommentToFile);
    // Same one-shot consume for text picked out of a file preview.
    const selectedStore = useSelectedTextStore.getState();
    const selectedSnippets = selectedTextForChat(selectedStore.items, currentWorkspaceId, dbChatId);
    const selectedFiles = selectedSnippets.map(selectedTextToFile);
    const extraFiles = [...annFiles, ...lineCommentFiles, ...selectedFiles];
    const merged = extraFiles.length > 0
      ? { ...message, files: [...message.files, ...extraFiles] as FileUIPart[] }
      : message;
    submitMessage(merged, attachments.files, setInput);
    for (const a of annotations) annStore.remove(a.id);
    lineStore.clearWorkspace(currentWorkspaceId);
    selectedStore.clearWorkspace(currentWorkspaceId);
    trackEvent('message_sent', {
      provider_id: currentProviderId,
      model: model || undefined,
      has_attachments: attachments.files.length > 0 || extraFiles.length > 0,
    });
  }, [attachments.files, currentWorkspaceId, model, providerId, selectedModel?.providerId, setInput, submitMessage, handleCompact]);

  // --- Goal (codex) ---
  const sendGoalMessage = useCallback((objective: string) => {
    return sendMessage({ text: objective }, { body: { asGoal: true } });
  }, [sendMessage]);
  const { goal, pending: goalPending, startGoal, clearGoal, pauseGoal, resumeGoal } = useGoal({
    dbChatId,
    messages,
    supported: supportsGoal,
    isGenerating,
    sendGoalMessage,
    stop,
  });
  // "Goal" is a pre-send mode toggle, NOT a send action: clicking it only arms
  // goal mode (highlight). The actual goal only starts when the user sends the
  // message (Enter / submit button) while armed — see handleSubmitOrGoal.
  const [goalArmed, setGoalArmed] = useState(false);
  const handleToggleGoal = useCallback(() => {
    setGoalArmed((v) => !v);
  }, []);
  // Disarm if the provider stops supporting goals (e.g. model switch).
  useEffect(() => {
    if (!supportsGoal && goalArmed) setGoalArmed(false);
  }, [supportsGoal, goalArmed]);
  // Wraps the normal submit: when goal mode is armed, route the outgoing text
  // through startGoal instead of a plain turn, then disarm.
  const handleSubmitOrGoal = useCallback((message: { text: string; files: FileUIPart[] }) => {
    const text = message.text.trim();
    if (goalArmed && supportsGoal && text) {
      const hasContext = message.files.length > 0 || attachments.files.length > 0
        || annotationsForWorkspace(useAnnotationsStore.getState().items, currentWorkspaceId).length > 0
        || lineCommentsForWorkspace(useLineCommentsStore.getState().items, currentWorkspaceId).length > 0
        || selectedTextForChat(useSelectedTextStore.getState().items, currentWorkspaceId, dbChatId).length > 0;
      if (hasContext) {
        toast.error('Goals currently support text only. Send attachments and context in a regular message first.');
        return;
      }
      if (!startGoal(text)) return;
      setGoalArmed(false);
      setInput('');
      return;
    }
    handleSubmit(message);
  }, [goalArmed, supportsGoal, startGoal, handleSubmit, setInput, attachments.files.length, currentWorkspaceId, dbChatId]);

  // One-click "send" from the browser annotation toolbar: when its nonce bumps
  // for this workspace, the focused chat submits the queued annotations. Consume
  // immediately so only one panel acts.
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;
  const sendNonce = useAnnotationSendStore((s) => s.nonce);
  useEffect(() => {
    if (sendNonce === 0 || !visible) return;
    const { workspaceId: reqWs, consume } = useAnnotationSendStore.getState();
    // Browser-send leaves the browser panel focused. The visible conversation
    // in the matching workspace consumes the request once.
    if (reqWs !== currentWorkspaceId) return;
    const anns = annotationsForWorkspace(useAnnotationsStore.getState().items, currentWorkspaceId);
    if (anns.length === 0) { consume(); return; }
    consume();
    handleSubmitRef.current({ text: input.trim(), files: [] });
  }, [sendNonce, currentWorkspaceId, input, visible]);

  const submitSteerItem = useCallback(async (item: LiveSteerItem) => {
    const currentChatId = tab?.chatId ?? dbChatIdRef.current;
    let failureStatus: 'failed' | 'unknown' = 'failed';

    try {
      if (!currentChatId) throw new Error('Chat is not ready');

      // Once dispatched, a transport failure cannot tell us whether it arrived.
      failureStatus = 'unknown';
      const result = await api.aiInject({
        chatId: currentChatId,
        content: item.text,
        turnMessageId: item.turnMessageId,
        messageId: item.messageId,
      });
      if (!result.success && result.delivery !== 'accepted') {
        failureStatus = result.delivery === 'not-sent' ? 'failed' : 'unknown';
        throw new Error(result.error ?? 'Failed to steer');
      }
      const messageId = result.message?.id ?? item.messageId;
      if (!messageId) throw new Error('Steer response did not include a message id');

      setLiveSteers((current) =>
        current.map((entry) =>
          entry.localId === item.localId
            ? { ...entry, messageId, status: 'sent' }
            : entry,
        ),
      );
    } catch (error) {
      console.error('[ChatPanel] Steer failed:', error);
      setLiveSteers((current) =>
        current.map((entry) =>
          entry.localId === item.localId ? { ...entry, status: failureStatus } : entry,
        ),
      );
    }
  }, [dbChatIdRef, tab?.chatId]);

  const handleSteer = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const item: LiveSteerItem = {
      localId: `live-steer-${crypto.randomUUID()}`,
      // Chosen here rather than by the server, so the reply's marker for where
      // the agent read it can be matched to this item even before /inject answers.
      messageId: crypto.randomUUID(),
      text: trimmed,
      turnMessageId: findLatestTurnMessageId(messagesRef.current),
      status: 'sending',
    };

    setLiveSteers((current) => [...current, item]);
    setInput('');
    await submitSteerItem(item);
  }, [setInput, submitSteerItem]);

  const handleRetrySteer = useCallback((localId: string) => {
    const item = liveSteers.find((entry) => entry.localId === localId);
    if (!item || item.status !== 'failed') return;

    // Only a known unsent attempt can be retried; uncertain deliveries keep their id.
    const retryItem = { ...item, messageId: crypto.randomUUID(), status: 'sending' as const };
    setLiveSteers((current) =>
      current.map((entry) => (entry.localId === localId ? retryItem : entry)),
    );
    void submitSteerItem(retryItem);
  }, [liveSteers, submitSteerItem]);

  const handleDismissSteer = useCallback((localId: string) => {
    setLiveSteers((current) => current.filter((item) => item.localId !== localId));
  }, []);

  // The moment the agent reads a follow-up, the reply shows it in place
  // (`data-injected-input`), so it leaves the tray. Only this turn can hold one:
  // scan back to the user message that started it.
  const readSteerIds = useMemo(() => {
    const ids: string[] = [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'user' && !isSteerUserMessage(message)) break;
      for (const part of message.parts) {
        const injected = getInjectedInput(part);
        if (injected) ids.push(injected.id);
      }
    }
    return ids.join('\n');
  }, [messages]);
  useEffect(() => {
    if (!readSteerIds) return;
    const read = new Set(readSteerIds.split('\n'));
    setLiveSteers((current) => {
      const next = current.filter((item) => !item.messageId || !read.has(item.messageId));
      return next.length === current.length ? current : next;
    });
  }, [readSteerIds]);

  const handleLoadMoreHistory = useCallback(() => {
    chatLoadMore(messages);
  }, [chatLoadMore, messages]);

  // Server-delivered child results do not appear in this tab's local steer tray.
  // Subscribe only to the derived flag, then reconcile history when its turn ends.
  const hasExternalChildren = useExternalAgentsStore((state) =>
    [...state.agents.values()].some((agent) => agent.parentChatId === (tab?.chatId ?? dbChatId)),
  );
  const sentSteerCount = liveSteers.reduce(
    (count, item) => count + (item.status === 'sent' && item.messageId ? 1 : 0),
    0,
  );

  // Waits out `turnSettling` as well as `isGenerating`: a stopped turn leaves
  // `isGenerating` false while the node is still writing the partial reply, and
  // reconciling against that half-written tail replaces the transcript with a
  // version that is missing everything the turn had already streamed.
  useEffect(() => {
    if (!historyLoaded || isGenerating || turnSettling) return;
    if (sentSteerCount === 0 && !hasExternalChildren) return;

    const currentChatId = tab?.chatId ?? dbChatIdRef.current;
    if (!currentChatId) return;

    let active = true;

    api
      .chatHistoryGet(currentChatId, { limit: TAIL_SYNC_SIZE })
      .then(async (result) => {
        if (!active) return;
        const tail = await normalizeHistoryMessages(result?.messages ?? []);
        if (!active) return;
        // A steer that was just sent lands at the end of the transcript, so the
        // tail page is enough to decide which ones the server has persisted —
        // this never needed the whole conversation.
        const persistedMessageIds = new Set(tail.map((message) => message.id));
        setMessages((current) => mergeServerTail(current, tail));
        setLiveSteers((current) =>
          current.filter(
            (item) =>
              item.status !== 'sent' ||
              !item.messageId ||
              !persistedMessageIds.has(item.messageId),
          ),
        );
      })
      .catch((error) => {
        console.error('[ChatPanel] Failed to sync steer messages:', error);
      });

    return () => {
      active = false;
    };
  }, [dbChatIdRef, historyLoaded, isGenerating, turnSettling, hasExternalChildren, sentSteerCount, setMessages, tab?.chatId]);

  useEffect(() => {
    setLiveSteers([]);
  }, [chatId]);

  return (
    <div
      ref={transcriptRef}
      className={cn(
        "h-full flex flex-col relative",
        // Desktop: the session cards get a column of their own and the chat (composer
        // included) slides over to make room, in step with the cards sliding in.
        !isMobile && "transition-[padding-right] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
        !isMobile && agentPanelOpen && SESSION_PANEL_PAD_CLASS,
      )}
    >
      <RewindConfirmDialog
        open={rewindDialogOpen}
        mode={rewindMode}
        onOpenChange={setRewindDialogOpen}
        onCancel={cancelRewind}
        onConfirm={confirmRewind}
      />
      <RewindConflictDialog
        files={pendingConflicts?.files ?? null}
        onOpenChange={(open) => { if (!open) dismissConflicts(); }}
        onDismiss={dismissConflicts}
        onConfirm={confirmConflicts}
      />
      {isCanvasChatId(chatId) && <CanvasChatBanner chatId={chatId} />}
      <SelectionToolbar
        containerRef={transcriptRef}
        targetSelector='[data-message-item-role="assistant"]'
        actions={selectionActions}
      />
      <Conversation
        className="flex-1 rounded-xl bg-background font-sans"
        // Resize the scrolling viewport when the keyboard appears. Padding only
        // the content leaves the viewport unchanged, so it cannot follow the end.
        style={isMobile ? { paddingBottom: 'var(--keyboard-height, 0px)' } : undefined}
      >
        <ScrollTopLoader
          hasMore={chatHasMore}
          loadingMore={chatLoadingMore}
          onLoadMore={handleLoadMoreHistory}
        />
        <ConversationContent
          // Fade the edges that meet the tab bar and the composer toolbar
          // instead of clipping a half-cut row of text there.
          // Chromium's thin scrollbar takes an 11px gutter on the right, which
          // pushed the centred column ~5px left of the composer below. Reserving
          // the same gutter on both edges keeps the two columns aligned (and
          // stops the column jumping when the transcript starts to overflow).
          // Not on a phone: there the transcript runs on under the floating
          // composer, and a faded edge would leave its glass nothing to frost.
          // overscroll-y-contain: wheeling down at the bottom otherwise latches the
          // gesture to the viewport, so reversing straight away scrolled nothing
          // until the wheel paused and a new gesture started.
          scrollClassName={cn("[scrollbar-gutter:stable_both-edges]", !isMobile && "scroll-fade-y overscroll-y-contain")}
          // The viewport already clears the keyboard; leave room only for the
          // composer floating over the remaining visible part of the transcript.
          style={isMobile ? { paddingBottom: "calc(var(--composer-height, 0px) + 16px)" } : undefined}
          className={cn(
            "w-full max-w-4xl mx-auto px-4 pt-5 pb-4 gap-1",
            // Phone: the transcript runs under the status bar and the floating
            // back button; start the first message just below them. Not where
            // the native top bar is a real bar above the web view (Android) —
            // there is nothing to run under, so the room is already made.
            isMobile && !nativeTopBarTakesSpace() && "pt-[calc(env(safe-area-inset-top)+3rem)]"
          )}
        >
          {messages.length === 0 ? (
            historyDbChatId && !historyLoaded ? null : null
          ) : (
            <ChatDbIdContext.Provider value={dbChatId}>
            <MessagesList
              messages={messages}
              status={status}
              onPermissionDecide={handlePermissionDecide}
              onSendTo={handleSendTo}
              onSendToTab={handleSendToTab}
              currentChatId={chatId}
              availableModels={sendToAvailableModels}
              onSendToOpen={loadGlobalModels}
              onRewindToCheckpoint={tab?.options?.autoRun ? undefined : handleRewindToCheckpoint}
              rewindedCheckpoint={tab?.options?.autoRun ? undefined : rewindedCheckpoint}
              onUndoRewind={tab?.options?.autoRun ? undefined : handleUndoRewind}
              turnDiffs={tab?.options?.autoRun ? undefined : turnDiffs}
              onReviewTurn={tab?.options?.autoRun ? undefined : handleReviewTurn}
              externalAgentNotificationsByTaskId={externalAgentNotificationsByTaskId}
            />
            </ChatDbIdContext.Provider>
          )}
          <ChatWaitingIndicator active={(status === 'submitted' || status === 'streaming')} />
        </ConversationContent>
        {chatLoadingMore && (
          <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-background/90 px-3 py-1 text-xs text-muted-foreground">
            <FormattedMessage id="editor.chat.loadingOlder" defaultMessage="Loading older messages..." />
          </div>
        )}
        {/* Rendered after the transcript so it paints over the left gutter. */}
        <ChatNavigator entries={navigatorEntries} />
        {/*
          Frosted so the transcript shows through it. On phones the metrics pills
          float in the bottom-right of this same band, and they sit above this
          button. Lift it clear of that row so the two never overlap.
        */}
        <ConversationScrollButton
          glass
          style={isMobile ? { bottom: "calc(var(--composer-height, 0px) + 12px + var(--keyboard-height, 0px))" } : undefined}
        />
      </Conversation>

      <div
        ref={composerRef}
        className={cn(
          "relative w-full max-w-[min(56rem,calc(100%-2*var(--transcript-gutter,0px)))] mx-auto px-4 pb-4 pt-0",
          // Phone: floats over the bottom of the transcript, which scrolls on
          // under its glass (the card itself is frosted; around it, nothing).
          // `absolute` also anchors the floating metrics row (see below).
          isMobile && "absolute inset-x-0 bottom-0 z-20 px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom))]",
          isMobile &&
            "group-data-[keyboard-open=true]/mobile-shell:fixed group-data-[keyboard-open=true]/mobile-shell:bottom-[var(--keyboard-height)] group-data-[keyboard-open=true]/mobile-shell:z-50 group-data-[keyboard-open=true]/mobile-shell:max-w-none group-data-[keyboard-open=true]/mobile-shell:px-4 group-data-[keyboard-open=true]/mobile-shell:pb-1 group-data-[keyboard-open=true]/mobile-shell:pt-2"
        )}
      >
        {chatError && status === 'error' && (
          <NoticeGlass on={isMobile}>
          <div className="mb-2 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4 shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
            <span className="break-all">{chatError.message || intl.formatMessage({ id: 'editor.chat.errorOccurred', defaultMessage: 'An error occurred' })}</span>
          </div>
          </NoticeGlass>
        )}
        {(isCompacting || compactResult || showCompactBanner) && (
        <NoticeGlass on={isMobile}>
        {isCompacting ? (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-status-info/10 px-3 py-1.5 text-xs text-status-info">
            <svg className="size-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="32" strokeLinecap="round" /></svg>
            <span><FormattedMessage id="editor.compact.loading" defaultMessage="Compacting conversation history..." /></span>
          </div>
        ) : compactResult ? (
          <div className="mb-2 flex items-center justify-between rounded-lg bg-status-ok/10 px-3 py-1.5 text-xs text-status-ok">
            <span>
              {compactResult.originalMessageCount && compactResult.newMessageCount
                ? intl.formatMessage(
                    { id: 'editor.compact.doneMessages', defaultMessage: 'Context compacted ({original} messages → {updated} for model)' },
                    { original: compactResult.originalMessageCount, updated: compactResult.newMessageCount },
                  )
                : intl.formatMessage({ id: 'editor.compact.done', defaultMessage: 'Context compacted' })}
            </span>
            <button className="ml-2 rounded px-1.5 py-0.5 hover:bg-status-ok/10 transition-colors" onClick={() => setCompactResult(null)}>
              &times;
            </button>
          </div>
        ) : showCompactBanner ? (
          <div className="mb-2 flex items-center justify-between rounded-lg bg-status-warn/10 px-3 py-1.5 text-xs text-status-warn">
            <span>
              {compactedInfo.originalTokenCount && compactedInfo.newTokenCount
                ? intl.formatMessage(
                    { id: 'editor.compact.doneTokens', defaultMessage: 'Context compacted ({original} → {updated} tokens)' },
                    { original: compactedInfo.originalTokenCount, updated: compactedInfo.newTokenCount },
                  )
                : intl.formatMessage({ id: 'editor.compact.done', defaultMessage: 'Context compacted' })}
            </span>
            <button className="ml-2 rounded px-1.5 py-0.5 hover:bg-status-warn/10 transition-colors" onClick={() => setCompactDismissed(JSON.stringify(compactedInfo))}>
              &times;
            </button>
          </div>
        ) : null}
        </NoticeGlass>
        )}
        {showCacheExpiredNotice ? (() => {
          const clearCommand = <code className="rounded bg-status-warn/15 px-1 font-mono">/clear</code>;
          const cachedTokens = displayedContextUsage?.usedTokens;

          return (
            <NoticeGlass on={isMobile}>
            <div className="mb-2 flex items-start justify-between gap-2 rounded-lg border border-status-warn/15 bg-status-warn/10 px-3 py-1.5 text-xs text-status-warn">
              <span>
                {cachedTokens ? (
                  <FormattedMessage
                    id="editor.cacheExpiry.withTokens"
                    defaultMessage="Prompt cache expired after an hour idle — {tokens} tokens are no longer cached and will be re-read on your next message. Use {command} to start fresh."
                    values={{ tokens: cachedTokens.toLocaleString(), command: clearCommand }}
                  />
                ) : (
                  <FormattedMessage
                    id="editor.cacheExpiry.noTokens"
                    defaultMessage="Prompt cache expired after an hour idle — this conversation is no longer cached. Use {command} to start fresh."
                    values={{ command: clearCommand }}
                  />
                )}
              </span>
              <button
                type="button"
                className="ml-2 shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-status-warn/15"
                onClick={dismissCacheExpiredNotice}
                aria-label={intl.formatMessage({ id: 'editor.cacheExpiry.dismiss', defaultMessage: 'Dismiss' })}
              >
                &times;
              </button>
            </div>
            </NoticeGlass>
          );
        })() : null}
        {/*
          Session / rate-limit / context pills. They float just above the
          composer, over the bottom of the transcript, instead of sitting in the
          layout, so they cost no height. The row lets clicks through to the
          transcript underneath; only the pills themselves take them.

          Desktop pills are translucent + blurred so the text scrolling under
          them stays legible as a smudge rather than colliding with the labels.

          No `backdrop-blur` here: with the keyboard up this row's parent turns
          into a blurred surface and becomes the backdrop root, so a blur on the
          pills can only sample inside that parent — they sit above it, so it
          silently does nothing and they read as plain translucent. Dropping it
          keeps them looking the same whether the keyboard is up or not.
        */}
        {!metricsInSessionPanel && (
        <div
          ref={pillsRef}
          className={cn(
            "flex items-start gap-2",
            isMobile
              ? "pointer-events-none absolute bottom-full right-3 z-20 mb-1 max-w-[calc(100%-1.5rem)] flex-wrap justify-end [&>*]:pointer-events-auto"
              // Spans the composer's width (not sized to content) so the
              // `@container` queries below still have a width to measure.
              : "@container pointer-events-none absolute inset-x-4 bottom-full z-10 mb-2 min-w-0 flex-nowrap items-center justify-end [&>*]:pointer-events-auto"
          )}
        >
          {showContextUsage && displayedContextUsage ? (
            isMobile ? (
              <MobileContextUsage
                chatId={dbChatId}
                detailedContextUsage={displayedContextUsage.detailedContextUsage}
                maxTokens={displayedContextUsage.maxTokens}
                usage={displayedContextUsage.usage}
                usedTokens={displayedContextUsage.usedTokens}
              />
            ) : (
              <Context chatId={dbChatId} detailedContextUsage={displayedContextUsage.detailedContextUsage} maxTokens={displayedContextUsage.maxTokens} usage={displayedContextUsage.usage} usedTokens={displayedContextUsage.usedTokens}>
                <ContextTrigger className={floatingPillClassName} />
                <ContextContent>
                  <ContextDetailedContent />
                </ContextContent>
              </Context>
            )
          ) : null}
        </div>
        )}
        {latestTodos.length > 0 ? (
          <div className="mb-2 max-h-[150px] overflow-y-auto rounded-xl border border-border/50 bg-background px-3 py-2 code-scrollbar dark:border-border/35">
            <TodoQueue todos={latestTodos} live={status === 'streaming' || status === 'submitted'} />
          </div>
        ) : null}
        <AnnotationTray workspaceId={currentWorkspaceId} />
        <SelectedTextTray workspaceId={currentWorkspaceId} chatId={dbChatId} />
        <LineCommentTray workspaceId={currentWorkspaceId} />
        <WorkflowApprovalsBar chatId={tab?.chatId ?? dbChatIdRef.current} />
        <SpecChatBar chatId={tab?.chatId ?? dbChatIdRef.current} />
        {goal && (
          <GoalBanner
            goal={goal}
            pending={goalPending || !dbChatId}
            isGenerating={isGenerating}
            onClear={clearGoal}
            onPause={pauseGoal}
            onResume={resumeGoal}
          />
        )}
        <SteerTray
          items={liveSteers}
          canRetry={isGenerating}
          onRetry={handleRetrySteer}
          onDismiss={handleDismissSteer}
        />
        {readOnlyReason != null ? (
          <div
            role="status"
            className={cn(
              "rounded-xl px-4 py-3 text-xs text-muted-foreground",
              isMobile ? "liquid-glass" : "border border-border/50 bg-muted/20 dark:border-border/35",
            )}
          >
            {readOnlyReason}
          </div>
        ) : <ChatInputArea
          visible={visible}
          input={input}
          setInput={setInput}
          attachments={attachments}
          onSubmit={handleSubmitOrGoal}
          status={status}
          onStop={() => void stop()}
          isGenerating={isGenerating}
          selectorOpen={selectorOpen}
          setSelectorOpen={setSelectorOpen}
          selectedModel={selectedModel}
          availableModels={availableModels}
          model={model}
          setModel={handleSetModelAndRemember}
          thinkingEffort={thinkingEffort}
          cycleThinkingEffort={cycleThinkingEffort}
          setThinkingEffort={setThinkingEffortAndRemember}
          thinkingEffortOptions={thinkingEffortOptions}
          modeOptions={modeOptions}
          currentMode={currentMode}
          cycleMode={handleCycleMode}
          setMode={handleSetMode}
          modeButtonClass={modeButtonClass}
          supportsDynamicSwitch={canDynamicSwitch && tab?.isSubAgent !== true}
          canEditTurnSettings={(supportsDynamicSwitch || (selectedModel?.providerId ?? providerId) === 'codex') && tab?.isSubAgent !== true}
          canSteer={isGenerating && supportsInjection && !!(tab?.chatId ?? dbChatIdRef.current)}
          steerPending={steerPending}
          onSteer={handleSteer}
          serviceTierOptions={serviceTierOptions}
          currentServiceTier={currentServiceTier}
          toggleFastMode={handleToggleFastMode}
          goalSupported={supportsGoal}
          goalArmed={goalArmed}
          onToggleGoal={handleToggleGoal}
          slashCommands={mergedSlashCommands}
          compactWhenIdle={isMobile}
          floating={isMobile}
          mobileKeyboardOpen={isMobile && mobileKeyboardOpen}
          hasPendingContext={pendingAnnotationCount > 0 || pendingLineCommentCount > 0}
          pendingSkill={pendingSkill}
          onPendingSkillConsumed={() => setPendingSkill(null)}
        />}
      </div>
      <AgentPanel
        open={agentPanelOpen}
        chatId={tab?.chatId ?? dbChatIdRef.current}
        providerId={sessionPanelProviderId}
        variant={isMobile ? 'overlay' : 'inline'}
        usageCards={sessionUsageCards}
        facts={sessionFacts}
        onClose={closeSessionPanel}
        onUseSkill={handleSessionPanelSkill}
      />
      {isMobile && dbChatId !== undefined && reviewCwd && mobileReviewMessageUid ? (
        <MobileSheet
          open
          onClose={() => setMobileReviewMessageUid(null)}
          bodyClassName="px-0 pb-0"
        >
          <Suspense fallback={<div className="h-[70vh] p-4 text-xs text-muted-foreground/70">Loading review...</div>}>
            <MobileTurnDiffReview
              chatId={dbChatId}
              rootPath={reviewCwd}
              messageUid={mobileReviewMessageUid}
            />
          </Suspense>
        </MobileSheet>
      ) : null}
    </div>
  );
}

/** Watches scroll position and triggers loadMore when user scrolls near top */
function ScrollTopLoader({
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const { scrollRef } = useConversationScroll();
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      // Fetch a screen and a half early, so the page is in before the reader
      // reaches the top instead of while they wait there.
      if (el.scrollTop < el.clientHeight * 1.5 && hasMore && !loadingMore) {
        onLoadMore();
      }
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [scrollRef, hasMore, loadingMore, onLoadMore]);

  return null;
}

// Desktop metrics pills float over the transcript. Keep the blur small: at 24px
// the black text underneath averaged out into a flat grey slab; at 8px with a
// 75% fill the pill reads white with only a faint hint of what's behind it.
// `!`: the triggers' own `shadow-none` survives cn(), which can't tell that
// the custom `shadow-card` replaces it.
const floatingPillClassName =
  "shrink-0 border-border/50 bg-popover/75 shadow-card! backdrop-blur-sm backdrop-saturate-[1.8] dark:border-border/35 @max-[460px]:gap-1 @max-[460px]:px-2";

/**
 * Phone: a notice above the floating composer sits over the transcript, and its
 * 10% tint alone let the messages behind read through it. The composer's glass
 * goes underneath, the tint stays on top; elsewhere the notice is unchanged.
 */
function NoticeGlass({ on, children }: { on: boolean; children: React.ReactNode }) {
  if (!on) return <>{children}</>;
  return <div className="mb-2 overflow-hidden rounded-lg liquid-glass [&>*]:mb-0">{children}</div>;
}
