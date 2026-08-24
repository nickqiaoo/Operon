import { memo } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { AlertCircle, Check, Loader2, RotateCcw, X } from 'lucide-react';
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemContent,
} from '@/components/ai-elements/queue';
import type { LiveSteerItem } from './steer-message';

type SteerTrayProps = {
  items: readonly LiveSteerItem[];
  canRetry: boolean;
  onRetry: (localId: string) => void;
  onDismiss: (localId: string) => void;
};

export const SteerTray = memo(function SteerTray({ items, canRetry, onRetry, onDismiss }: SteerTrayProps) {
  const intl = useIntl();
  if (items.length === 0) return null;

  return (
    <Queue
      data-testid="steer-tray"
      className="mb-1 max-h-24 gap-0 overflow-y-auto rounded-lg border-tint/15 bg-tint/5 px-1 py-0.5 shadow-none code-scrollbar"
    >
      <ul>
        {items.map((item) => (
          <QueueItem
            key={item.localId}
            data-testid="steer-tray-item"
            data-status={item.status}
            className="px-2 py-0.5 text-xs hover:bg-tint/5"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              {item.status === 'sending' ? (
                <Loader2 aria-hidden="true" className="size-3 shrink-0 animate-spin text-tint" />
              ) : item.status === 'sent' ? (
                <Check aria-hidden="true" className="size-3 shrink-0 text-tint" />
              ) : (
                <AlertCircle aria-hidden="true" className="size-3 shrink-0 text-destructive" />
              )}
              <QueueItemContent title={item.text} className="min-w-0 text-xs text-foreground/80">
                {item.text}
              </QueueItemContent>
              <span
                className={
                  item.status === 'failed'
                    ? 'shrink-0 text-[11px] text-destructive'
                    : 'shrink-0 text-[11px] text-muted-foreground'
                }
              >
                {item.status === 'sending' ? (
                  <FormattedMessage id="editor.steer.sending" defaultMessage="Sending…" />
                ) : item.status === 'sent' ? (
                  <FormattedMessage id="editor.steer.sent" defaultMessage="Sent" />
                ) : (
                  <FormattedMessage id="editor.steer.failed" defaultMessage="Couldn't send" />
                )}
              </span>
              {item.status === 'failed' ? (
                <QueueItemActions className="gap-0.5">
                  {canRetry ? (
                    <QueueItemAction
                      data-testid="steer-retry"
                      className="opacity-100"
                      onClick={() => onRetry(item.localId)}
                      aria-label={intl.formatMessage({ id: 'editor.steer.retry', defaultMessage: 'Retry' })}
                    >
                      <RotateCcw className="size-3" />
                    </QueueItemAction>
                  ) : null}
                  <QueueItemAction
                    data-testid="steer-dismiss"
                    className="opacity-100"
                    onClick={() => onDismiss(item.localId)}
                    aria-label={intl.formatMessage({ id: 'editor.steer.dismiss', defaultMessage: 'Dismiss' })}
                  >
                    <X className="size-3" />
                  </QueueItemAction>
                </QueueItemActions>
              ) : null}
            </div>
          </QueueItem>
        ))}
      </ul>
    </Queue>
  );
});
