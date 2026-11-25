import { useChatApi } from '@/lib/chat-api-context';
import type { Api } from '@/lib/api';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UIMessage } from 'ai';
import type { SshEnvironmentRef } from '@shared/ssh-environment';

/**
 * Deliberately small: a page is sized by bytes on the wire, not by what fits on
 * screen. Tool parts carry their full output (command stdout, file contents) and
 * are ~92% of a transcript's bytes, so 50 messages routinely meant multiple MB —
 * enough to pull a whole 50-message conversation in one request. The scroll
 * handler in ChatPanel loads older pages on demand, so a small page costs a
 * round-trip only for someone who actually scrolls back.
 */
const CHAT_PAGE_SIZE = 10;

/** Ids that appear more than once in a message list (for dup diagnostics). */
const findDuplicateIds = (messages: UIMessage[]): string[] => {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const m of messages) {
    if (seen.has(m.id)) dups.add(m.id);
    else seen.add(m.id);
  }
  return [...dups];
};

/** `file://` attachments are read from the machine the chat lives on. */
type HistoryFileReader = Pick<Api, 'readFile'>;

const normalizeFileUrlToDataUrl = async (url: string, chatApi: HistoryFileReader): Promise<string> => {
  if (url.startsWith('file://')) {
    try {
      const filePath = decodeURIComponent(url.replace(/^file:\/\//, ''));
      const fileContent = await chatApi.readFile(filePath);
      return `data:text/plain;charset=utf-8,${encodeURIComponent(fileContent)}`;
    } catch {
      return url;
    }
  }
  return url;
};

export const normalizeMessageAttachments = async (message: UIMessage, chatApi: HistoryFileReader): Promise<UIMessage> => {
  if (!message.parts.length) return message;
  const nextParts = await Promise.all(
    message.parts.map(async (part) => {
      if (part.type !== 'file') return part;
      const nextUrl = await normalizeFileUrlToDataUrl(part.url, chatApi);
      if (nextUrl === part.url) return part;
      return { ...part, url: nextUrl };
    })
  );
  return { ...message, parts: nextParts };
};

export const normalizeHistoryMessages = async (messages: UIMessage[], chatApi: HistoryFileReader): Promise<UIMessage[]> =>
  Promise.all(messages.map((message) => normalizeMessageAttachments(message, chatApi)));

export function useChatHistory(
  dbChatId: number | undefined,
  setMessages: (messages: UIMessage[] | ((current: UIMessage[]) => UIMessage[])) => void,
  timestamp?: number
) {
  const api = useChatApi();
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [loadedModel, setLoadedModel] = useState<string | null>(null);
  const [loadedProviderId, setLoadedProviderId] = useState<string | null>(null);
  const [loadedThinkingLevel, setLoadedThinkingLevel] = useState<string | null>(null);
  /** The mode the chat last ran or was switched to (server-side `metadata.modeId`). */
  const [loadedModeId, setLoadedModeId] = useState<string | null>(null);
  const [loadedSshEnvironment, setLoadedSshEnvironment] = useState<SshEnvironmentRef>();
  /** Server-side time of the last persisted message — survives closing the tab. */
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState<number | null>(null);
  /**
   * Why the first page did not load (the machine the chat lives on is offline, a
   * server error). `historyLoaded` is still set, so nothing waits on it forever;
   * ChatPanel shows this instead of an empty conversation.
   */
  const [loadError, setLoadError] = useState<unknown>(null);
  /** Bumped by `retry` to load the first page again. */
  const [attempt, setAttempt] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Synchronous twin of `loadingMore`: two scroll / resize callbacks in one frame both saw the state false. */
  const loadingMoreRef = useRef(false);
  const setMessagesRef = useRef(setMessages);
  const nextCursorRef = useRef<number | undefined>(undefined);
  const dbChatIdRef = useRef(dbChatId);

  useEffect(() => {
    setMessagesRef.current = setMessages;
  }, [setMessages]);

  useEffect(() => {
    dbChatIdRef.current = dbChatId;
  }, [dbChatId]);

  useEffect(() => {
    let active = true;
    setHistoryLoaded(false);
    setMessagesRef.current([]);
    setHasMore(false);
    setLoadedUpdatedAt(null);
    setLoadedSshEnvironment(undefined);
    setLoadedModeId(null);
    setLoadError(null);
    nextCursorRef.current = undefined;

    if (dbChatId === undefined) {
      setHistoryLoaded(true);
      return;
    }

    // Until this returns ChatPanel shows its "Loading conversation…" state
    // (keyed off `historyLoaded`); on web it is a WAN round trip.
    api.chatHistoryGet(dbChatId, { limit: CHAT_PAGE_SIZE })
      .then(async (result) => {
        if (!active) return;
        const rawMessages: UIMessage[] = result?.messages ?? [];
        const normalized = await normalizeHistoryMessages(rawMessages, api);
        if (!active) return;
        const initialDups = findDuplicateIds(normalized);
        if (initialDups.length) {
          console.warn('[useChatHistory] duplicate ids in initial page (server returned dups):', initialDups, 'chatId', dbChatId);
        }
        setMessagesRef.current(normalized);
        setHasMore(result?.hasMore ?? false);
        setLoadedSshEnvironment(result?.sshEnvironment);
        nextCursorRef.current = result?.nextCursor;
        if (result?.model) {
          setLoadedModel(result.model);
        }
        if (result?.providerId) {
          setLoadedProviderId(result.providerId);
        }
        if (result?.thinkingLevel) {
          setLoadedThinkingLevel(result.thinkingLevel);
        }
        if (result?.modeId) {
          setLoadedModeId(result.modeId);
        }
        if (typeof result?.updatedAt === 'number') {
          setLoadedUpdatedAt(result.updatedAt);
        }
        setHistoryLoaded(true);
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadError(error ?? new Error('Failed to load conversation'));
          setHistoryLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, [dbChatId, timestamp, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const loadMore = useCallback(async () => {
    const chatId = dbChatIdRef.current;
    if (!chatId || !hasMore || loadingMoreRef.current) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const cursor = nextCursorRef.current;
      const result = await api.chatHistoryGet(chatId, { before: cursor, limit: CHAT_PAGE_SIZE });
      const rawMessages: UIMessage[] = result?.messages ?? [];
      const normalized = await normalizeHistoryMessages(rawMessages, api);
      // Switched to another conversation while the page was in flight.
      if (dbChatIdRef.current !== chatId) return;
      setHasMore(result?.hasMore ?? false);
      nextCursorRef.current = result?.nextCursor;
      // Merged into the list as it is NOW, not as the caller saw it: useChat hands
      // components a throttled copy, so right after the first page lands the caller
      // can still be holding `[]` — prepending to that replaced the newest page with
      // the older one, and every page after it left a hole in the transcript.
      setMessagesRef.current((current) => {
        // Page boundaries can re-return a message → duplicate id.
        const currentIds = new Set(current.map((m) => m.id));
        const olderUnique = normalized.filter((m) => !currentIds.has(m.id));
        if (olderUnique.length < normalized.length) {
          console.warn('[useChatHistory] loadMore page overlapped current messages (deduped), cursor', cursor);
        }
        return olderUnique.length > 0 ? [...olderUnique, ...current] : current;
      });
    } catch (err) {
      console.error('[useChatHistory] Failed to load more:', err);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [hasMore]);

  return { historyLoaded, loadError, retry, loadedModel, loadedProviderId, loadedThinkingLevel, loadedModeId, loadedUpdatedAt, loadedSshEnvironment, hasMore, loadingMore, loadMore };
}
