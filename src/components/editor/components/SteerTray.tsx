import { memo } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { AlertCircle, Check, LoaderCircle, RotateCcw, X } from 'lucide-react';
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemContent,
  QueueItemDescription,
  QueueItemIndicator,
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
      className="mb-1 max-h-24 gap-1 overflow-y-auto rounded-lg border border-tint/15 bg-tint/5 px-2.5 py-1.5 code-scrollbar"
    >
      {items.map((item) => (
        <QueueItem
          key={item.localId}
          data-testid="steer-tray-item"
          data-status={item.status}
          status={item.status === 'sending' ? 'running' : item.status === 'failed' ? 'error' : undefined}
          className="w-full text-xs"
        >
          <QueueItemIndicator>
            {item.status === 'sending' ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : item.status === 'sent' ? (
              <Check className="size-3.5 text-tint" />
            ) : (
              <AlertCircle className="size-3.5" />
            )}
          </QueueItemIndicator>
          <QueueItemContent title={item.text} className="text-foreground/80">
            {item.text}
          </QueueItemContent>
          <QueueItemDescription className={item.status === 'failed' ? 'text-status-error' : undefined}>
            {item.status === 'sending' ? (
              <FormattedMessage id="editor.steer.sending" defaultMessage="Sending…" />
            ) : item.status === 'sent' ? (
              <FormattedMessage id="editor.steer.sent" defaultMessage="Sent" />
            ) : item.status === 'unknown' ? (
              <FormattedMessage id="editor.steer.unknown" defaultMessage="Delivery unknown" />
            ) : (
              <FormattedMessage id="editor.steer.failed" defaultMessage="Couldn't send" />
            )}
          </QueueItemDescription>
          {item.status === 'failed' || item.status === 'unknown' ? (
            <QueueItemActions className="ml-auto">
              {canRetry && item.status === 'failed' ? (
                <QueueItemAction
                  data-testid="steer-retry"
                  onClick={() => onRetry(item.localId)}
                  aria-label={intl.formatMessage({ id: 'editor.steer.retry', defaultMessage: 'Retry' })}
                >
                  <RotateCcw />
                </QueueItemAction>
              ) : null}
              <QueueItemAction
                data-testid="steer-dismiss"
                onClick={() => onDismiss(item.localId)}
                aria-label={intl.formatMessage({ id: 'editor.steer.dismiss', defaultMessage: 'Dismiss' })}
              >
                <X />
              </QueueItemAction>
            </QueueItemActions>
          ) : null}
        </QueueItem>
      ))}
    </Queue>
  );
});
