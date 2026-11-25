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
import { cn } from '@/lib/utils';
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
    // A strip tucked onto the composer's top edge, a little narrower than it:
    // open at the bottom so it reads as part of the composer, not another card.
    <Queue
      data-testid="steer-tray"
      className="mx-4 w-auto max-h-28 gap-0 overflow-y-auto rounded-t-xl border border-b-0 border-border/50 bg-muted/30 px-3 py-1 code-scrollbar dark:border-border/35"
    >
      {items.map((item) => (
        <QueueItem
          key={item.localId}
          data-testid="steer-tray-item"
          data-status={item.status}
          status={item.status === 'sending' ? 'running' : item.status === 'failed' ? 'error' : undefined}
          className="h-7 w-full"
        >
          <QueueItemIndicator>
            {item.status === 'sending' ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : item.status === 'sent' ? (
              <Check className="size-3.5" />
            ) : (
              <AlertCircle className="size-3.5" />
            )}
          </QueueItemIndicator>
          <QueueItemContent title={item.text} className="text-foreground">
            {item.text || (
              <FormattedMessage
                id="editor.steer.attachmentsOnly"
                defaultMessage="{count, plural, one {# attachment} other {# attachments}}"
                values={{ count: item.files?.length ?? 0 }}
              />
            )}
          </QueueItemContent>
          <QueueItemDescription className={cn('ml-auto shrink-0 text-xs', item.status === 'failed' && 'text-status-error')}>
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
            <QueueItemActions className="-mr-1">
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
