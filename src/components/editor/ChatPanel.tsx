'use client';

import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import type { FileUIPart } from 'ai';
import { Layers } from 'lucide-react';
import { AgentPanel } from './agent/AgentPanel';
import { skillsList } from './agent/agentControl';
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from '@/components/ai-elements/queue';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { buildChatNavigatorEntries, ChatNavigator } from './components/ChatNavigator';
import { useStickToBottomContext } from 'use-stick-to-bottom';
import {
  PromptInputProvider,
  usePromptInputController,
} from '@/components/ai-elements/prompt-input';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useEditorStore } from '@/stores/editor-store';
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
import { extractContextCompaction } from './utils/chatMetadata';
import { useChatIndexState } from './hooks/useChatIndexState';
import { useRewindController } from './hooks/useRewindController';
import { useChatPanelEffects } from './hooks/useChatPanelEffects';
import { useSendToModels } from './hooks/useSendToModels';
import { useChatRuntime } from './hooks/useChatRuntime';
import { useClaudeUsagePolling } from './hooks/useClaudeUsagePolling';
import { useCacheExpiryNotice } from './hooks/useCacheExpiryNotice';
import { useChatSessionControls } from './hooks/useChatSessionControls';
import { MessagesList } from './components/MessagesList';
import type { TurnDiffFile } from './components/TurnDiffCard';
import { ChatInputArea } from './components/ChatInputArea';
import { SteerTray } from './components/SteerTray';
import {
  findLatestTurnMessageId,
  type LiveSteerItem,
} from './components/steer-message';
import { GoalBanner } from './components/GoalBanner';
import { useGoal } from './hooks/useGoal';
import { useProjectStore } from '@/stores/project-store';
import { useTabsStore } from '@/stores/tabs-store';
import { useReviewTurnStore } from '@/stores/review-turn-store';
import { useAppShellStore } from '@/stores/app-shell-store';
import { WorkflowApprovalsBar } from './components/WorkflowRunsWatcher';
import { CreatePRButton } from './components/CreatePRButton';
import { RewindConfirmDialog, RewindConflictDialog } from './components/RewindConfirmDialog';
import { extractTodosFromPart, isTodoWriteTool } from './components/TodoWriteRenderer';
import { CanvasChatBanner } from './components/CanvasChatBanner';
import { isCanvasChatId } from '@/lib/canvas-utils';
import { trackEvent } from '@/lib/analytics';
import { AutoScrollManager } from './components/AutoScrollManager';
import { ChatWaitingIndicator } from './components/ChatWaitingIndicator';
import { CodexRateLimitsButton } from './components/CodexRateLimitsButton';
import { ClaudeRateLimitsButton, MobileClaudeRateLimits } from './components/ClaudeRateLimitsButton';
import { useChatNotifications } from '@/hooks/useNotification';
import { useVisibleChatInboxRead } from '@/hooks/useVisibleChatInboxRead';
import { cn } from '@/lib/utils';
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
  return (
    <PromptInputProvider>
      <ChatPanelContent {...props} />
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
  const currentWorkspaceId = useEditorStore((state) => state.currentWorkspaceId);
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

  // Selection toolbar over the transcript. The container is the whole panel and
  // the targetSelector is what actually narrows it to assistant messages, so a
  // selection in the composer or in a user's own message raises nothing.
  const transcriptRef = useRef<HTMLDivElement | null>(null);
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

  const tabs = useEditorStore((state) => state.tabs);
  const appliedTabInputKeyRef = useRef<string | null>(null);

  const modelManagement = useModelManagement(
    tab?.options?.modelId ?? recentOptionsState.options.modelId ?? '',
    providerId,
    recentOptionsState.options,
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
    lastMessageId,
    lastMessageTextSize,
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
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const isClaudeCode = providerId === 'claude-code' || selectedModel?.providerId === 'claude-code';
  const {
    detailedContextUsage: polledContextUsage,
    claudeRateLimits: polledClaudeRateLimits,
  } = useClaudeUsagePolling({
    chatId: dbChatId,
    isClaudeCode,
    supportsContextUsage,
    isActive: activeTabId === chatId,
    isGenerating,
  });
  useEffect(() => {
    setStreaming(chatId, isGenerating);
    // All ChatPanels stay mounted across workspaces. Only clear the unseen
    // badge if this tab is the one the user is actually viewing.
    if (!isGenerating && activeTabId === chatId) {
      clearUnseen([chatId]);
    }
    return () => setStreaming(chatId, false);
  }, [chatId, isGenerating, setStreaming, clearUnseen, activeTabId]);

  useAttachmentLoader(tab?.options?.inputAttachment, chatId, attachments.add, clearTabInputAttachment);


  useLayoutEffect(() => {
    if (!tab?.options?.input) return;

    const inputKey = `${chatId}:${tab.options.timestamp ?? 'no-ts'}:${tab.options.input}`;
    if (appliedTabInputKeyRef.current === inputKey) return;

    appliedTabInputKeyRef.current = inputKey;
    setInput(tab.options.input);
  }, [chatId, setInput, tab?.options?.input, tab?.options?.timestamp]);

  const cycleThinkingEffort = useCallback(() => {
    const idx = thinkingEffortOptions.findIndex((option) => option.value === thinkingEffort);
    const nextEffort =
      thinkingEffortOptions[(idx + 1) % thinkingEffortOptions.length]?.value ??
      thinkingEffort;
    setThinkingEffort(nextEffort);
    rememberRecentOptions({ thinkingEffort: nextEffort });
    // No live call: effort cannot take mid-stream on most runtimes. It rides the
    // next message like any other param, and the session manager decides then
    // whether the session can absorb it or has to be rebuilt.
  }, [rememberRecentOptions, thinkingEffort, thinkingEffortOptions]);

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
    canDynamicSwitch,
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
  }, [
    currentServiceTier,
    rememberRecentOptions,
    serviceTierOptions,
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
    lastAssistant,
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
  const displayedContextUsage = polledContextUsage
    ? {
        usage: contextUsage?.usage,
        maxTokens: polledContextUsage.maxTokens,
        usedTokens: polledContextUsage.totalTokens,
        detailedContextUsage: polledContextUsage,
      }
    : contextUsage;
  // Quota comes from the account-level poll only. Assistant messages used to
  // carry a snapshot in their metadata; old chats still have those rows, but
  // they are frozen at the time of the turn (weeks stale, resets long past), so
  // falling back to one made the badge jump backwards whenever the poll had no
  // value yet. Better to show nothing than a number from another window.
  const displayedClaudeRateLimits = isClaudeCode ? polledClaudeRateLimits : null;

  const {
    externalAgentTasks,
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
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  // Operon skills surfaced into the composer's `/` menu (same slash-command flow
  // as built-ins). Lazily fetched the first time a slash command is started.
  const [operonSkillCommands, setOperonSkillCommands] = useState<SlashCommandItem[]>([]);
  const operonSkillsLoadedRef = useRef(false);
  const isOperonProvider = providerId === 'custom' || selectedModel?.providerId === 'custom';
  const isCodexProvider = providerId === 'codex' || selectedModel?.providerId === 'codex';
  const isOpencodeProvider = providerId === 'opencode' || selectedModel?.providerId === 'opencode';
  const sessionPanelProviderId = isClaudeCode
    ? 'claude-code'
    : isOperonProvider
      ? 'custom'
      : isCodexProvider
        ? 'codex'
        : isOpencodeProvider
          ? 'opencode'
          : undefined;

  useEffect(() => {
    if (!sessionPanelProviderId) setAgentPanelOpen(false);
  }, [sessionPanelProviderId]);

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
  const reviewCwd = useProjectStore((s) => s.getActiveWorkspace()?.worktreePath ?? null);
  const openTab = useTabsStore((s) => s.openTab);
  const setRightPanelOpen = useAppShellStore((s) => s.setRightPanelOpen);
  const [turnDiffs, setTurnDiffs] = useState<{
    turns: Array<{ messageUid: string; snapshotId: string; files: TurnDiffFile[] }>;
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
    firstUserTitle,
    updateTabTitle,
    externalAgentTasks,
    externalAgentNotificationsByTaskId,
    lastAssistant,
    currentDbChatId: dbChatIdRef.current,
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
    void sendMessage({ text: objective }, { body: { asGoal: true } });
  }, [sendMessage]);
  const { goal, startGoal, clearGoal, pauseGoal, resumeGoal } = useGoal({
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
      startGoal(text);
      setGoalArmed(false);
      setInput('');
      return;
    }
    handleSubmit(message);
  }, [goalArmed, supportsGoal, startGoal, handleSubmit, setInput]);

  // One-click "send" from the browser annotation toolbar: when its nonce bumps
  // for this workspace, the focused chat submits the queued annotations. Consume
  // immediately so only one panel acts.
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;
  const sendNonce = useAnnotationSendStore((s) => s.nonce);
  useEffect(() => {
    if (sendNonce === 0) return;
    const { workspaceId: reqWs, consume } = useAnnotationSendStore.getState();
    // Browser-send leaves the browser tab active (no focused chat), so we can't
    // gate on activeTabId. Only the active workspace's chats are mounted; match
    // the workspace and consume-once so a single panel handles it.
    if (reqWs !== currentWorkspaceId) return;
    const anns = annotationsForWorkspace(useAnnotationsStore.getState().items, currentWorkspaceId);
    if (anns.length === 0) { consume(); return; }
    consume();
    handleSubmitRef.current({ text: input.trim(), files: [] });
  }, [sendNonce, currentWorkspaceId, input]);

  const submitSteerItem = useCallback(async (item: LiveSteerItem) => {
    const currentChatId = tab?.chatId ?? dbChatIdRef.current;

    try {
      if (!currentChatId) throw new Error('Chat is not ready');

      const result = await api.aiInject({
        chatId: currentChatId,
        content: item.text,
        turnMessageId: item.turnMessageId,
      });
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to steer');
      }
      if (!result.message?.id) throw new Error('Steer response did not include a message id');

      setLiveSteers((current) =>
        current.map((entry) =>
          entry.localId === item.localId
            ? { ...entry, messageId: result.message?.id, status: 'sent' }
            : entry,
        ),
      );
    } catch (error) {
      console.error('[ChatPanel] Steer failed:', error);
      setLiveSteers((current) =>
        current.map((entry) =>
          entry.localId === item.localId ? { ...entry, status: 'failed' } : entry,
        ),
      );
    }
  }, [dbChatIdRef, tab?.chatId]);

  const handleSteer = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const item: LiveSteerItem = {
      localId: `live-steer-${crypto.randomUUID()}`,
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

    const retryItem = { ...item, status: 'sending' as const };
    setLiveSteers((current) =>
      current.map((entry) => (entry.localId === localId ? retryItem : entry)),
    );
    void submitSteerItem(retryItem);
  }, [liveSteers, submitSteerItem]);

  const handleDismissSteer = useCallback((localId: string) => {
    setLiveSteers((current) => current.filter((item) => item.localId !== localId));
  }, []);

  const handleLoadMoreHistory = useCallback(() => {
    chatLoadMore(messages);
  }, [chatLoadMore, messages]);

  const sentSteerCount = liveSteers.reduce(
    (count, item) => count + (item.status === 'sent' && item.messageId ? 1 : 0),
    0,
  );

  useEffect(() => {
    if (isGenerating || sentSteerCount === 0) return;

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
  }, [dbChatIdRef, isGenerating, sentSteerCount, setMessages, tab?.chatId]);

  useEffect(() => {
    setLiveSteers([]);
  }, [chatId]);

  return (
    <div ref={transcriptRef} className="h-full flex flex-col relative">
      <RewindConfirmDialog
        open={rewindDialogOpen}
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
      <Conversation className="flex-1 rounded-xl bg-background font-sans">
        <AutoScrollManager
          status={status}
          messageCount={messages.length}
          lastMessageId={lastMessageId}
          lastMessageTextSize={lastMessageTextSize}
          historyLoaded={historyLoaded}
        />
        <ScrollTopLoader
          hasMore={chatHasMore}
          loadingMore={chatLoadingMore}
          onLoadMore={handleLoadMoreHistory}
        />
        <ConversationContent
          className={cn(
            "w-full max-w-4xl mx-auto px-4 pt-5 pb-4 gap-1",
            isMobile && "group-data-[keyboard-open=true]/mobile-shell:pb-44"
          )}
        >
          {chatLoadingMore && (
            <div className="flex items-center justify-center py-3 text-xs text-muted-foreground/50">
              <FormattedMessage id="editor.chat.loadingOlder" defaultMessage="Loading older messages..." />
            </div>
          )}
          {messages.length === 0 ? (
            historyDbChatId && !historyLoaded ? null : null
          ) : (
            <MessagesList
              messages={messages}
              status={status}
              onPermissionDecide={handlePermissionDecide}
              onSendTo={handleSendTo}
              onSendToTab={handleSendToTab}
              tabs={tabs}
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
          )}
          <ChatWaitingIndicator active={(status === 'submitted' || status === 'streaming')} />
        </ConversationContent>
        {/* Rendered after the transcript so it paints over the left gutter. */}
        <ChatNavigator entries={navigatorEntries} />
        {/*
          On phones the metrics pills float in the bottom-right of this same
          band, and they sit above this button. Lift it clear of that row so the
          two never overlap.
        */}
        <ConversationScrollButton className={cn(isMobile && "bottom-14 size-9 shadow-float")} />
      </Conversation>

      <div
        className={cn(
          "w-full max-w-4xl mx-auto px-4 pb-4 pt-0",
          // `relative` anchors the phone's floating metrics row (see below).
          isMobile && "relative px-3 pb-2",
          isMobile &&
            "group-data-[keyboard-open=true]/mobile-shell:fixed group-data-[keyboard-open=true]/mobile-shell:inset-x-0 group-data-[keyboard-open=true]/mobile-shell:bottom-[var(--keyboard-height)] group-data-[keyboard-open=true]/mobile-shell:z-50 group-data-[keyboard-open=true]/mobile-shell:max-w-none group-data-[keyboard-open=true]/mobile-shell:bg-background/95 group-data-[keyboard-open=true]/mobile-shell:px-4 group-data-[keyboard-open=true]/mobile-shell:pb-1 group-data-[keyboard-open=true]/mobile-shell:pt-2 group-data-[keyboard-open=true]/mobile-shell:backdrop-blur"
        )}
      >
        {chatError && status === 'error' && (
          <div className="mb-2 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4 shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
            <span className="break-all">{chatError.message || intl.formatMessage({ id: 'editor.chat.errorOccurred', defaultMessage: 'An error occurred' })}</span>
          </div>
        )}
        {isCompacting ? (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-blue-500/10 px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400">
            <svg className="size-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="32" strokeLinecap="round" /></svg>
            <span><FormattedMessage id="editor.compact.loading" defaultMessage="Compacting conversation history..." /></span>
          </div>
        ) : compactResult ? (
          <div className="mb-2 flex items-center justify-between rounded-lg bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-600 dark:text-emerald-400">
            <span>
              {compactResult.originalMessageCount && compactResult.newMessageCount
                ? intl.formatMessage(
                    { id: 'editor.compact.doneMessages', defaultMessage: 'Context compacted ({original} messages → {updated} for model)' },
                    { original: compactResult.originalMessageCount, updated: compactResult.newMessageCount },
                  )
                : intl.formatMessage({ id: 'editor.compact.done', defaultMessage: 'Context compacted' })}
            </span>
            <button className="ml-2 rounded px-1.5 py-0.5 hover:bg-emerald-500/10 transition-colors" onClick={() => setCompactResult(null)}>
              &times;
            </button>
          </div>
        ) : showCompactBanner ? (
          <div className="mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400">
            <span>
              {compactedInfo.originalTokenCount && compactedInfo.newTokenCount
                ? intl.formatMessage(
                    { id: 'editor.compact.doneTokens', defaultMessage: 'Context compacted ({original} → {updated} tokens)' },
                    { original: compactedInfo.originalTokenCount, updated: compactedInfo.newTokenCount },
                  )
                : intl.formatMessage({ id: 'editor.compact.done', defaultMessage: 'Context compacted' })}
            </span>
            <button className="ml-2 rounded px-1.5 py-0.5 hover:bg-amber-500/10 transition-colors" onClick={() => setCompactDismissed(JSON.stringify(compactedInfo))}>
              &times;
            </button>
          </div>
        ) : null}
        {showCacheExpiredNotice ? (() => {
          const clearCommand = <code className="rounded bg-status-warn/15 px-1 font-mono">/clear</code>;
          const cachedTokens = displayedContextUsage?.usedTokens;

          return (
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
          );
        })() : null}
        {/*
          Session / rate-limit / context pills. On phones they float just above
          the composer instead of sitting in the layout, so they cost no height
          in an already cramped viewport. The row is sized to its content and
          right-aligned, leaving the rest of the transcript clickable underneath.

          No `backdrop-blur` here: with the keyboard up this row's parent turns
          into a blurred surface and becomes the backdrop root, so a blur on the
          pills can only sample inside that parent — they sit above it, so it
          silently does nothing and they read as plain translucent. Dropping it
          keeps them looking the same whether the keyboard is up or not.
        */}
        <div
          className={cn(
            "flex items-start gap-2",
            isMobile
              ? "pointer-events-none absolute bottom-full right-3 z-20 mb-1 max-w-[calc(100%-1.5rem)] flex-wrap justify-end [&>*]:pointer-events-auto"
              : "@container mb-2 min-w-0 flex-nowrap items-center"
          )}
        >
          {!isMobile && (
            <div className="flex min-w-0 flex-1 items-center">
              <CreatePRButton />
            </div>
          )}
          {sessionPanelProviderId ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setAgentPanelOpen(true)}
              className="h-8 shrink-0 gap-1.5 rounded-full border-border/60 bg-background/70 px-3 text-xs shadow-none hover:bg-muted/40 @max-[560px]:size-8 @max-[560px]:gap-0 @max-[560px]:px-0"
              aria-label={intl.formatMessage({ id: 'editor.agentPanel.open', defaultMessage: 'Session panel' })}
            >
              <Layers aria-hidden="true" className="size-3.5" />
              <span className="@max-[560px]:hidden">
                <FormattedMessage id="editor.agentPanel.trigger" defaultMessage="Session" />
              </span>
            </Button>
          ) : null}
          {(providerId === 'codex' || selectedModel?.providerId === 'codex') && codexUsageDetails ? (
            <CodexRateLimitsButton
              account={codexUsageDetails.account}
              rateLimits={codexUsageDetails.rateLimits}
              className="shrink-0 @max-[460px]:gap-1 @max-[460px]:px-2"
            />
          ) : null}
          {isClaudeCode && displayedClaudeRateLimits ? (
            isMobile ? (
              <MobileClaudeRateLimits rateLimits={displayedClaudeRateLimits} />
            ) : (
              <ClaudeRateLimitsButton
                rateLimits={displayedClaudeRateLimits}
                className="shrink-0 @max-[460px]:gap-1 @max-[460px]:px-2"
              />
            )
          ) : null}
          {displayedContextUsage ? (
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
                <ContextTrigger className="shrink-0 @max-[460px]:gap-1 @max-[460px]:px-2" />
                <ContextContent>
                  <ContextDetailedContent />
                </ContextContent>
              </Context>
            )
          ) : null}
        </div>
        {latestTodos.length > 0 ? (() => {
          const completedCount = latestTodos.filter((e) => e.status === 'completed').length;
          const inProgressCount = latestTodos.filter((e) => e.status === 'in_progress').length;
          const allCompleted = completedCount === latestTodos.length;
          const label = allCompleted
            ? intl.formatMessage({ id: 'editor.todos.completed', defaultMessage: 'tasks completed' })
            : inProgressCount > 0
              ? intl.formatMessage({ id: 'editor.todos.progress', defaultMessage: 'tasks ({done}/{total} done)' }, { done: completedCount, total: latestTodos.length })
              : intl.formatMessage({ id: 'editor.todos.label', defaultMessage: 'tasks' });

          return (
            <Queue className="max-h-[150px] overflow-y-auto code-scrollbar mb-2 border-border/50">
              <QueueSection key={allCompleted ? 'done' : 'active'} defaultOpen={!allCompleted}>
                <QueueSectionTrigger>
                  <QueueSectionLabel count={allCompleted ? completedCount : latestTodos.length} label={label} />
                </QueueSectionTrigger>
                <QueueSectionContent>
                  <div>
                    {latestTodos.map((entry, k) => {
                      const isCompleted = entry.status === 'completed';
                      const isInProgress = entry.status === 'in_progress';
                      const displayText = isInProgress && entry.activeForm ? entry.activeForm : entry.content;
                      return (
                        <QueueItem key={k}>
                          <div className="flex items-center gap-2">
                            <QueueItemIndicator completed={isCompleted} inProgress={isInProgress} />
                            <QueueItemContent completed={isCompleted}>{displayText}</QueueItemContent>
                          </div>
                        </QueueItem>
                      );
                    })}
                  </div>
                </QueueSectionContent>
              </QueueSection>
            </Queue>
          );
        })() : null}
        <AnnotationTray workspaceId={currentWorkspaceId} />
        <SelectedTextTray workspaceId={currentWorkspaceId} chatId={dbChatId} />
        <LineCommentTray workspaceId={currentWorkspaceId} />
        <WorkflowApprovalsBar chatId={tab?.chatId ?? dbChatIdRef.current} />
        {goal && (
          <GoalBanner
            goal={goal}
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
        <ChatInputArea
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
          thinkingEffortOptions={thinkingEffortOptions}
          modeOptions={modeOptions}
          currentMode={currentMode}
          cycleMode={handleCycleMode}
          modeButtonClass={modeButtonClass}
          supportsDynamicSwitch={canDynamicSwitch}
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
          mobileKeyboardOpen={isMobile && mobileKeyboardOpen}
          hasPendingContext={pendingAnnotationCount > 0 || pendingLineCommentCount > 0}
          pendingSkill={pendingSkill}
          onPendingSkillConsumed={() => setPendingSkill(null)}
        />
      </div>
      <AgentPanel
        open={agentPanelOpen}
        chatId={tab?.chatId ?? dbChatIdRef.current}
        providerId={sessionPanelProviderId}
        onClose={() => setAgentPanelOpen(false)}
        // A skill picked in the panel arrives as a chip in the composer — the same state a
        // `/` pick produces — rather than as text or as a message sent on your behalf.
        onUseSkill={(skill) => {
          setPendingSkill({ type: 'skill', name: skill.name, description: skill.description })
          setAgentPanelOpen(false)
        }}
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
  const { scrollRef } = useStickToBottomContext();
  const pendingAnchorRef = useRef<{ height: number; top: number } | null>(null);

  // Only restore scroll after older messages are prepended (loadingMore transition).
  useLayoutEffect(() => {
    if (loadingMore) return;
    const anchor = pendingAnchorRef.current;
    if (!anchor) return;
    const el = scrollRef.current;
    pendingAnchorRef.current = null;
    if (!el) return;
    const diff = el.scrollHeight - anchor.height;
    if (diff > 0) el.scrollTop = anchor.top + diff;
  }, [loadingMore, scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      if (el.scrollTop < 100 && hasMore && !loadingMore) {
        pendingAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
        onLoadMore();
      }
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [scrollRef, hasMore, loadingMore, onLoadMore]);

  return null;
}
