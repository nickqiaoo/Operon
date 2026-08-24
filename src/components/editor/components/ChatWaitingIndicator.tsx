import { useEffect, useRef, useState } from 'react';
import { Loader } from '@/components/ai-elements/loader';

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

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader size={14} />
      <span className="tabular-nums">{formatElapsed(elapsedMs)}</span>
    </div>
  );
}
