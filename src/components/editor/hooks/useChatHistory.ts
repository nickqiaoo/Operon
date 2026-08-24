import { api } from "@/lib/api";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UIMessage } from 'ai';

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

const normalizeFileUrlToDataUrl = async (url: string): Promise<string> => {
  if (url.startsWith('file://')) {
    try {
      const filePath = decodeURIComponent(url.replace(/^file:\/\//, ''));
      const fileContent = await api.readFile(filePath);
      return `data:text/plain;charset=utf-8,${encodeURIComponent(fileContent)}`;
    } catch {
      return url;
    }
  }
  return url;
};

export const normalizeMessageAttachments = async (message: UIMessage): Promise<UIMessage> => {
  if (!message.parts.length) return message;
  const nextParts = await Promise.all(
    message.parts.map(async (part) => {
      if (part.type !== 'file') return part;
      const nextUrl = await normalizeFileUrlToDataUrl(part.url);
      if (nextUrl === part.url) return part;
      return { ...part, url: nextUrl };
    })
  );
  return { ...message, parts: nextParts };
};

export const normalizeHistoryMessages = async (messages: UIMessage[]): Promise<UIMessage[]> =>
  Promise.all(messages.map((message) => normalizeMessageAttachments(message)));

export function useChatHistory(
  dbChatId: number | undefined,
  setMessages: (messages: UIMessage[]) => void,
  timestamp?: number
) {
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [loadedModel, setLoadedModel] = useState<string | null>(null);
  const [loadedProviderId, setLoadedProviderId] = useState<string | null>(null);
  const [loadedThinkingLevel, setLoadedThinkingLevel] = useState<string | null>(null);
  /** Server-side time of the last persisted message — survives closing the tab. */
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
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
    nextCursorRef.current = undefined;

    if (dbChatId === undefined) {
      setHistoryLoaded(true);
      return;
    }

    api
      .chatHistoryGet(dbChatId, { limit: CHAT_PAGE_SIZE })
      .then(async (result) => {
        if (!active) return;
        const rawMessages: UIMessage[] = result?.messages ?? [];
        const normalized = await normalizeHistoryMessages(rawMessages);
        if (!active) return;
        const initialDups = findDuplicateIds(normalized);
        if (initialDups.length) {
          console.warn('[useChatHistory] duplicate ids in initial page (server returned dups):', initialDups, 'chatId', dbChatId);
        }
        setMessagesRef.current(normalized);
        setHasMore(result?.hasMore ?? false);
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
        if (typeof result?.updatedAt === 'number') {
          setLoadedUpdatedAt(result.updatedAt);
        }
        setHistoryLoaded(true);
      })
      .catch(() => {
        if (active) {
          setHistoryLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, [dbChatId, timestamp]);

  const loadMore = useCallback(async (currentMessages: UIMessage[]) => {
    const chatId = dbChatIdRef.current;
    if (!chatId || !hasMore || loadingMore) return;

    setLoadingMore(true);
    try {
      const cursor = nextCursorRef.current;
      const result = await api.chatHistoryGet(chatId, { before: cursor, limit: CHAT_PAGE_SIZE });
      const rawMessages: UIMessage[] = result?.messages ?? [];
      const normalized = await normalizeHistoryMessages(rawMessages);
      setHasMore(result?.hasMore ?? false);
      nextCursorRef.current = result?.nextCursor;
      // Prepend older messages, dropping any that overlap the current list
      // (page boundaries can re-return a message → duplicate id).
      const currentIds = new Set(currentMessages.map((m) => m.id));
      const overlap = normalized.filter((m) => currentIds.has(m.id)).map((m) => m.id);
      if (overlap.length) {
        console.warn('[useChatHistory] loadMore page overlapped current messages (deduped):', overlap, 'cursor', cursor);
      }
      const olderUnique = normalized.filter((m) => !currentIds.has(m.id));
      const merged = [...olderUnique, ...currentMessages];
      setMessagesRef.current(merged);
    } catch (err) {
      console.error('[useChatHistory] Failed to load more:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore]);

  return { historyLoaded, loadedModel, loadedProviderId, loadedThinkingLevel, loadedUpdatedAt, hasMore, loadingMore, loadMore };
}
