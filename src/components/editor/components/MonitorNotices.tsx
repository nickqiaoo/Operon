import type { ComponentProps } from 'react';
import { FormattedMessage } from 'react-intl';
import { CheckCircle2Icon, CircleSlashIcon, RadarIcon, TimerOffIcon, XCircleIcon } from 'lucide-react';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace';
import { CodeBlock, CodeBlockContent } from '@/components/ui/code-block';
import { ToolLine } from '@/components/ai-elements/tool';
import { cn } from '@/lib/utils';
import { useOperonTask } from '@/lib/agent-session-queries';
import { useChatBackgroundTaskStore } from '@/stores/chat-background-task-store';
import { useChatDbId, useChatProviderId } from './chat-db-id-context';
import { groupNotices, type BackgroundNotice, type MonitorOutcome, type NoticeRow } from './background-notice';

/**
 * Everything a Monitor shows in the chat.
 *
 * The tool call returns the moment the watch is armed, so its row alone would read
 * "done" while the command keeps running for up to half an hour. The row's tail reads
 * the watch's live state instead (`useMonitorTaskState`). Its events arrive later as
 * notices the runtime writes into the conversation (see background-notice.ts); each
 * is one more step line where it landed, with the same icon as the row that armed it,
 * so the reader can follow "event came in → agent reacted" in place.
 */

const MONITOR_ICON = RadarIcon;

export interface MonitorTaskState {
  running: boolean;
  outcome?: MonitorOutcome;
  /** Event batches delivered so far, when the runtime counts them (operon does, Claude Code doesn't). */
  events?: number;
  /** The monitor stopped itself because the command printed too much. */
  tooMuchOutput?: boolean;
}

/** The live state of the watch a Monitor call started, from whichever runtime runs the chat. */
export function useMonitorTaskState(toolCallId: string | undefined): MonitorTaskState | undefined {
  const chatId = useChatDbId();
  const providerId = useChatProviderId();
  const claudeTask = useChatBackgroundTaskStore((state) =>
    chatId == null || !toolCallId ? undefined : state.tasksByChat.get(chatId)?.find((task) => task.toolUseId === toolCallId),
  );
  const operonTask = useOperonTask(providerId, chatId, toolCallId);

  if (claudeTask) {
    const expired = /\bexpired\b/i.test(claudeTask.summary ?? '');
    return {
      running: claudeTask.status === 'running',
      outcome: claudeTask.status === 'running'
        ? undefined
        : expired ? 'expired' : claudeTask.status === 'completed' ? 'ok' : claudeTask.status === 'failed' ? 'error' : 'stopped',
    };
  }
  if (operonTask) {
    const monitor = operonTask.monitor;
    const status = operonTask.status;
    const outcome: MonitorOutcome | undefined = status === 'running'
      ? undefined
      : monitor?.endedBy === 'expired' || status === 'timed_out'
        ? 'expired'
        : status === 'completed'
          ? 'ok'
          : status === 'failed' || status === 'lost'
            ? 'error'
            : 'stopped';
    return {
      running: status === 'running',
      outcome,
      ...(monitor ? { events: monitor.eventsDelivered } : {}),
      ...(monitor?.endedBy === 'too_much_output' ? { tooMuchOutput: true } : {}),
    };
  }
  return undefined;
}

function EventCount({ count }: { count: number }) {
  return (
    <FormattedMessage
      id="editor.monitor.eventCount"
      defaultMessage="{count, plural, one {# event} other {# events}}"
      values={{ count }}
    />
  );
}

function OutcomeLabel({ outcome }: { outcome: MonitorOutcome }) {
  switch (outcome) {
    case 'ok':
      return <FormattedMessage id="editor.monitor.ended" defaultMessage="Ended" />;
    case 'error':
      return <FormattedMessage id="editor.monitor.failed" defaultMessage="Failed" />;
    case 'expired':
      return <FormattedMessage id="editor.monitor.expired" defaultMessage="Expired" />;
    case 'stopped':
      return <FormattedMessage id="editor.monitor.stopped" defaultMessage="Stopped" />;
  }
}

/** The Monitor row's tail: "Watching · 3 events", "Expired · 0 events", "Failed". */
function MonitorTaskTrailing({ state }: { state: MonitorTaskState }) {
  const tone = state.outcome === 'error'
    ? 'text-status-error'
    : state.tooMuchOutput || (state.outcome === 'expired' && state.events === 0)
      ? 'text-status-warn'
      : undefined;
  return (
    <TraceDescription className={cn('text-xs', tone)} data-testid="monitor-state">
      {state.running ? (
        <FormattedMessage id="editor.monitor.watching" defaultMessage="Watching" />
      ) : state.tooMuchOutput ? (
        <FormattedMessage id="editor.monitor.tooMuchOutput" defaultMessage="Stopped · too much output" />
      ) : state.outcome ? (
        <OutcomeLabel outcome={state.outcome} />
      ) : null}
      {state.events !== undefined && !state.tooMuchOutput && (
        <>
          {' · '}
          <EventCount count={state.events} />
        </>
      )}
    </TraceDescription>
  );
}

/**
 * The row of a Monitor call that armed its watch. The call itself is done, so the
 * row runs (shimmers) while the watch does, and its tail says how the watch is going.
 */
export function MonitorToolLine({ toolCallId, ...props }: ComponentProps<typeof ToolLine> & { toolCallId?: string }) {
  const state = useMonitorTaskState(toolCallId);
  if (!state) return <ToolLine {...props} />;
  return <ToolLine {...props} status={state.running ? 'running' : props.status} trailing={<MonitorTaskTrailing state={state} />} />;
}

/** First line of an event, for the collapsed row. */
const headline = (text: string) => text.split('\n').find((line) => line.trim())?.trim() ?? '';

function Detail({ text }: { text: string }) {
  return (
    <TraceCollapsibleContent className="space-y-2">
      <CodeBlock size="sm">
        <CodeBlockContent wrap className="max-h-64">{text}</CodeBlockContent>
      </CodeBlock>
      <p className="text-xs text-muted-foreground/70">
        <FormattedMessage id="editor.steerNotice.automated" defaultMessage="Automated event — not a message you sent." />
      </p>
    </TraceCollapsibleContent>
  );
}

function MonitorTitle({ description }: { description?: string }) {
  return (
    <TraceTitle className="max-w-[60%] shrink-0">
      {description || <FormattedMessage id="editor.monitor.title" defaultMessage="Monitor" />}
    </TraceTitle>
  );
}

/** A line of prose after the title: shrinks and truncates first, full text on hover. */
function Summary({ text, className }: { text: string; className?: string }) {
  return (
    <TraceDescription title={text} className={cn('min-w-0 shrink truncate', className)}>
      {text}
    </TraceDescription>
  );
}

function EventsRow({ row }: { row: Extract<NoticeRow, { kind: 'events' }> }) {
  const many = row.events.length > 1;
  const first = headline(row.events[0] ?? '');
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine data-testid="monitor-event">
          <TraceIcon><MONITOR_ICON /></TraceIcon>
          <MonitorTitle description={row.description} />
          {many ? (
            <TraceDescription className="text-xs"><EventCount count={row.events.length} /></TraceDescription>
          ) : first ? (
            <Summary text={first} className="font-mono text-xs" />
          ) : null}
        </TraceLine>
      </TraceCollapsibleTrigger>
      {/* A blank line between batches: each is one event, possibly several lines long. */}
      <Detail text={row.events.join('\n\n')} />
    </TraceCollapsible>
  );
}

const TASK_ICONS: Record<MonitorOutcome, typeof CheckCircle2Icon> = {
  ok: CheckCircle2Icon,
  error: XCircleIcon,
  stopped: CircleSlashIcon,
  expired: TimerOffIcon,
};

const OUTCOME_TONE: Record<MonitorOutcome, string | undefined> = {
  ok: 'text-status-ok',
  error: 'text-status-error',
  stopped: undefined,
  expired: undefined,
};

function SingleRow({ notice }: { notice: Exclude<BackgroundNotice, { type: 'monitor-event' }> }) {
  switch (notice.type) {
    case 'monitor-notice':
      return (
        <TraceLine data-testid="monitor-notice">
          <TraceIcon><MONITOR_ICON /></TraceIcon>
          <MonitorTitle description={notice.description} />
          <Summary text={notice.text} className={notice.warn ? 'text-status-warn' : undefined} />
        </TraceLine>
      );
    case 'monitor-ended': {
      const line = (
        <TraceLine status={notice.outcome === 'error' ? 'error' : undefined} data-testid="monitor-ended">
          <TraceIcon><MONITOR_ICON /></TraceIcon>
          <MonitorTitle description={notice.description} />
          <Summary text={notice.status} className={OUTCOME_TONE[notice.outcome]} />
        </TraceLine>
      );
      if (!notice.text) return line;
      // The last batch the command printed before it exited rides on the settle.
      return (
        <TraceCollapsible>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <Detail text={notice.text} />
        </TraceCollapsible>
      );
    }
    case 'task-done': {
      const Icon = TASK_ICONS[notice.outcome];
      return (
        <TraceLine status={notice.outcome === 'error' ? 'error' : undefined} data-testid="task-notification">
          <TraceIcon><Icon className={OUTCOME_TONE[notice.outcome]} /></TraceIcon>
          {notice.summary ? (
            <TraceTitle title={notice.summary}>{notice.summary}</TraceTitle>
          ) : (
            <TraceTitle>
              <FormattedMessage id="editor.msg.bgTaskFinished" defaultMessage="Background task finished" />
            </TraceTitle>
          )}
        </TraceLine>
      );
    }
  }
}

/**
 * The background notices one message carries. A run of one monitor's events is a
 * single row ("4 events", expand for all of them) so a chatty watch doesn't push
 * the agent's reaction to it off-screen.
 */
export function BackgroundNoticeList({ notices }: { notices: readonly BackgroundNotice[] }) {
  return (
    <Trace className="mt-1">
      {groupNotices(notices).map((row, index) =>
        row.kind === 'events'
          ? <EventsRow key={index} row={row} />
          : <SingleRow key={index} notice={row.notice} />,
      )}
    </Trace>
  );
}
