import type { UIMessage } from 'ai';

/** `42s`, `4m 47s`, `1h 3m`. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * How long the turn behind this reply ran, from the bounds the server stamps on
 * its metadata (`turnStartedAt` / `turnEndedAt`). Undefined for replies saved
 * before those existed, and for a turn that died before it ended.
 */
export function turnDurationMs(message: UIMessage): number | undefined {
  const metadata = message.metadata as { turnStartedAt?: unknown; turnEndedAt?: unknown } | undefined;
  const start = metadata?.turnStartedAt;
  const end = metadata?.turnEndedAt;
  if (typeof start !== 'number' || typeof end !== 'number' || end < start) return undefined;
  return end - start;
}
