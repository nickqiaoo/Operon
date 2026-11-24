import { useEffect, useRef, useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { Spinner } from '@/components/ui/spinner';
import { MessageCircleQuestionIcon } from 'lucide-react';
import { useChatPendingInputStore } from '@/stores/chat-pending-input-store';
import type { StreamMessageMetadata } from '@operon/agent-runtime';
import { formatElapsed } from './turn-duration';
import { useChatRef } from '@/lib/chat-api-context';
import { chatKey } from '@/lib/chat-ref';


export function ChatWaitingIndicator({ active, chatId, retry }: { active: boolean; chatId?: number; retry?: StreamMessageMetadata['retry'] }) {
  const chat = useChatRef(chatId);
  const key = chat ? chatKey(chat) : undefined;
  const needsInput = useChatPendingInputStore((s) =>
    key != null && s.pendingByChat.get(key)?.some((request) => !request.origin) === true);
  const working = active && !needsInput;
  const startRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (working) {
      if (!startRef.current) {
        startRef.current = Date.now();
        setElapsedMs(0);
      }
      return;
    }
    startRef.current = null;
    setElapsedMs(0);
  }, [working]);

  useEffect(() => {
    if (!working || !startRef.current) return;
    const interval = window.setInterval(() => {
      if (!startRef.current) return;
      setElapsedMs(Date.now() - startRef.current);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [working]);

  if (!active) return null;
  if (needsInput) {
    return (
      <Marker role="status" className="text-xs">
        <MarkerIcon><MessageCircleQuestionIcon /></MarkerIcon>
        <MarkerContent><FormattedMessage id="editor.tabs.needsInput" defaultMessage="Waiting for your input" /></MarkerContent>
      </Marker>
    );
  }
  const retrySeconds = retry ? Math.max(0, Math.ceil((retry.retryAt - Date.now()) / 1000)) : 0;

  // shadcn's live-status Marker: a spinner and shimmering text while the agent works.
  return (
    <Marker role="status" className="text-xs" title={retry?.reason}>
      <MarkerIcon className="size-3.5"><Spinner className="size-3.5" /></MarkerIcon>
      <MarkerContent className="shimmer">
        {retry
          ? `${retrySeconds > 0 ? `Retrying in ${retrySeconds}s` : 'Retrying'} (${retry.attempt}/${retry.maxAttempts})`
          : <FormattedMessage id="editor.waiting.working" defaultMessage="Working" />}
      </MarkerContent>
      <span className="tabular-nums text-muted-foreground/70">{formatElapsed(elapsedMs)}</span>
    </Marker>
  );
}
