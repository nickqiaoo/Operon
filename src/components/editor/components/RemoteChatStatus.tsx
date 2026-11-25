import { useEffect, useRef } from 'react';
import { AlertCircle, CloudOff, Monitor, RotateCw } from 'lucide-react';
import { FormattedMessage } from 'react-intl';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { useRemoteMachine } from '@/lib/machine-reachability';
import { isTransientRemoteError } from '@/stores/project-store';

/**
 * Above the composer of a conversation that lives on another machine: which
 * one, and whether it is reachable. Without it a remote chat looks exactly like
 * a local one, and nothing explains a chat that won't load or answer.
 */
export function RemoteMachineLabel({ nodeId }: { nodeId: string }) {
  const { label, unreachable } = useRemoteMachine(nodeId);
  return (
    <div data-testid="remote-machine-label" className="mb-1.5 flex min-w-0 items-center gap-1.5 px-3 text-xs text-muted-foreground">
      <Monitor className="size-3.5 shrink-0" />
      <span className="truncate">{label ?? <FormattedMessage id="editor.chat.remote.otherMachine" defaultMessage="Another machine" />}</span>
      {unreachable ? (
        <span className="shrink-0 text-status-warn">
          <FormattedMessage id="editor.chat.remote.offline" defaultMessage="Offline" />
        </span>
      ) : (
        <span className="shrink-0 text-muted-foreground/70">
          <FormattedMessage id="editor.chat.remote.badge" defaultMessage="Remote" />
        </span>
      )}
    </div>
  );
}

/**
 * The machine the chat lives on is away: Broker lists it offline, or the request
 * failed in a way that passes by itself (node_offline, a timeout, a 5xx).
 */
function machineAway(error: unknown, online: boolean | undefined): boolean {
  if (online === false) return true;
  return error instanceof ApiError ? isTransientRemoteError(error) : true;
}

/**
 * In place of the transcript when its first page did not load — before, the
 * panel just showed an empty conversation and a composer, with nothing saying
 * why. For another machine's chat it names the machine, and loads again by
 * itself once Broker lists it online.
 */
export function ChatLoadFailed({ nodeId, error, onRetry }: { nodeId?: string; error: unknown; onRetry: () => void }) {
  const { label, online } = useRemoteMachine(nodeId);
  const away = nodeId != null && machineAway(error, online);

  // Coming back online is the moment it can work: try again then.
  const wasOnline = useRef(online);
  useEffect(() => {
    if (nodeId != null && wasOnline.current === false && online === true) onRetry();
    wasOnline.current = online;
  }, [nodeId, online, onRetry]);

  const machine = label ?? 'the other machine';
  const detail = error instanceof Error ? error.message : null;
  return (
    <div
      role="alert"
      data-testid="chat-load-failed"
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background px-6 text-center animate-in fade-in-0 duration-200"
    >
      {away ? <CloudOff className="size-6 text-muted-foreground" /> : <AlertCircle className="size-6 text-muted-foreground" />}
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium text-foreground">
          {away ? (
            online === false
              ? <FormattedMessage id="editor.chat.loadFailed.offlineTitle" defaultMessage="{machine} is offline" values={{ machine }} />
              : <FormattedMessage id="editor.chat.loadFailed.unreachableTitle" defaultMessage="Can't reach {machine}" values={{ machine }} />
          ) : (
            <FormattedMessage id="editor.chat.loadFailed.title" defaultMessage="Couldn't load this conversation" />
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {away ? (
            <FormattedMessage
              id="editor.chat.loadFailed.offlineBody"
              defaultMessage="This conversation lives on {machine}. It will load once that machine is back online."
              values={{ machine }}
            />
          ) : (
            detail
          )}
        </p>
      </div>
      <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={onRetry}>
        <RotateCw className="h-3.5 w-3.5" />
        <FormattedMessage id="editor.chat.loadFailed.retry" defaultMessage="Try again" />
      </Button>
    </div>
  );
}
