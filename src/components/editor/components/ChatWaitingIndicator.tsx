import { useEffect, useRef, useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { Spinner } from '@/components/ui/spinner';

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function ChatWaitingIndicator({ active }: { active: boolean }) {
  const startRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (active) {
      if (!startRef.current) {
        startRef.current = Date.now();
        setElapsedMs(0);
      }
      return;
    }
    startRef.current = null;
    setElapsedMs(0);
  }, [active]);

  useEffect(() => {
    if (!active || !startRef.current) return;
    const interval = window.setInterval(() => {
      if (!startRef.current) return;
      setElapsedMs(Date.now() - startRef.current);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [active]);

  if (!active) return null;

  // shadcn's live-status Marker: a spinner and shimmering text while the agent works.
  return (
    <Marker role="status" className="text-xs">
      <MarkerIcon className="size-3.5"><Spinner className="size-3.5" /></MarkerIcon>
      <MarkerContent className="shimmer">
        <FormattedMessage id="editor.waiting.working" defaultMessage="Working" />
      </MarkerContent>
      <span className="tabular-nums text-muted-foreground/70">{formatElapsed(elapsedMs)}</span>
    </Marker>
  );
}
