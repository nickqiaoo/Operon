import { useIntl } from 'react-intl';
import { ArrowRightLeftIcon, CheckIcon, CornerDownRightIcon, LoaderIcon, WrenchIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Shared agent-stream model ────────────────────────────────────────
// A reducer (`reduceAgentChunk`) + presentational view (`AgentStreamView`)
// over an `AgentStreamState`, agnostic to which transport produced the chunks.
// Sub-agent inner chunks are multiplexed through the single per-run workflow
// stream (see useWorkflowStream) and folded with this SAME reducer, so every
// sub-agent path renders identically.

export interface TrackedToolCall {
  toolCallId: string;
  toolName: string;
  description: string;
  status: 'running' | 'done' | 'error';
}

export interface TimelineItem {
  /**
   * `steer`: a message the person sent the agent while it worked.
   * `replaced`: the person handed the work to another provider, which starts over from here.
   */
  kind: 'text' | 'tool' | 'steer' | 'replaced';
  text?: string;
  toolCallId?: string;
  from?: string;
  to?: string;
}

export interface AgentStreamState {
  toolCalls: TrackedToolCall[];
  timeline: TimelineItem[];
  text: string;
  error: string | null;
  isComplete: boolean;
  hasConnected: boolean;
}

export const INITIAL_AGENT_STREAM_STATE: AgentStreamState = {
  toolCalls: [],
  timeline: [],
  text: '',
  error: null,
  isComplete: false,
  hasConnected: false,
};

export function formatToolDescription(args: Record<string, unknown>): string {
  const path = args.file_path ?? args.path ?? args.filePath;
  if (path) return String(path);
  const cmd = args.command;
  if (cmd) return String(cmd).length > 100 ? String(cmd).slice(0, 100) + '...' : String(cmd);
  const pattern = args.pattern ?? args.query;
  if (pattern) return String(pattern);
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.length > 0) return v.length > 80 ? v.slice(0, 80) + '...' : v;
  }
  return '';
}

// ── Chunk parsing + reduction (shared by both stream paths) ──────────

/** Parse one SSE/NDJSON line into a chunk object (handles a `data:` prefix). */
export function parseStreamChunk(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to data: handling */
  }
  if (trimmed.startsWith('data:')) {
    try {
      return JSON.parse(trimmed.slice(5).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Fold one streamed chunk into an AgentStreamState (pure — returns a new state). */
export function reduceAgentChunk(prev: AgentStreamState, chunk: Record<string, unknown>): AgentStreamState {
  const type = chunk.type as string;

  switch (type) {
    case 'tool-input-available': {
      const toolCallId = String(chunk.toolCallId ?? '');
      if (prev.toolCalls.some((t) => t.toolCallId === toolCallId)) return prev;
      const toolName = String(chunk.toolName ?? 'unknown');
      const input = chunk.input as Record<string, unknown> | undefined;
      const description = input ? formatToolDescription(input) : '';
      return {
        ...prev,
        toolCalls: [...prev.toolCalls, { toolCallId, toolName, description, status: 'running' }],
        timeline: [...prev.timeline, { kind: 'tool', toolCallId }],
      };
    }
    case 'tool-output-available':
    case 'tool-output-error': {
      const toolCallId = String(chunk.toolCallId ?? '');
      const status: TrackedToolCall['status'] = type === 'tool-output-error' ? 'error' : 'done';
      return {
        ...prev,
        toolCalls: prev.toolCalls.map((t) => (t.toolCallId === toolCallId ? { ...t, status } : t)),
      };
    }
    case 'text-delta': {
      const delta = String(chunk.delta ?? '');
      if (!delta) return prev;
      const last = prev.timeline[prev.timeline.length - 1];
      const timeline: TimelineItem[] =
        last && last.kind === 'text'
          ? [...prev.timeline.slice(0, -1), { kind: 'text', text: (last.text ?? '') + delta }]
          : [...prev.timeline, { kind: 'text', text: delta }];
      return { ...prev, text: prev.text + delta, timeline };
    }
    case 'data-steer': {
      const text = String((chunk.data as { text?: unknown } | undefined)?.text ?? '');
      if (!text) return prev;
      return { ...prev, timeline: [...prev.timeline, { kind: 'steer', text }] };
    }
    case 'data-replaced': {
      const data = (chunk.data ?? {}) as { from?: unknown; to?: unknown };
      // The stopped session's abort error is not the agent failing.
      return {
        ...prev,
        error: null,
        timeline: [...prev.timeline, { kind: 'replaced', from: String(data.from ?? ''), to: String(data.to ?? '') }],
      };
    }
    case 'error':
      return { ...prev, error: String(chunk.errorText ?? 'Unknown error') };
    default:
      return prev;
  }
}

// ── Presentational detail view (text + tool calls, interleaved) ──────
// Pure — renders whatever AgentStreamState it is handed, regardless of which
// stream produced it. Used by the WorkflowRunsWatcher's expanded agent.
// Walks the timeline so the agent's text and tool calls appear in order.

function ToolRow({ tc }: { tc: TrackedToolCall }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {tc.status === 'done' ? (
        <CheckIcon className="size-3 shrink-0 text-status-ok" />
      ) : tc.status === 'error' ? (
        <XIcon className="size-3 shrink-0 text-destructive" />
      ) : (
        <LoaderIcon className="size-3 shrink-0 animate-spin text-muted-foreground" />
      )}
      <WrenchIcon className="size-3 shrink-0 text-muted-foreground/60" />
      <span className="font-medium">{tc.toolName}</span>
      {tc.description && (
        <code className={cn('truncate font-mono text-muted-foreground')}>{tc.description}</code>
      )}
    </div>
  );
}

export function AgentStreamView({ state }: { state: AgentStreamState }) {
  const intl = useIntl()
  if (state.timeline.length === 0 && !state.error) {
    return <div className="py-1 text-xs text-muted-foreground/60">{intl.formatMessage({ id: "editor.agentStream.noActivity", defaultMessage: "no activity yet" })}</div>;
  }

  const toolById = new Map(state.toolCalls.map((tc) => [tc.toolCallId, tc]));

  return (
    <div className="space-y-1 py-1">
      {state.timeline.map((item, i) => {
        if (item.kind === 'text') {
          if (!item.text || !item.text.trim()) return null;
          return (
            <div
              key={`text-${i}`}
              className="whitespace-pre-wrap break-words text-xs text-foreground/75"
            >
              {item.text}
            </div>
          );
        }
        if (item.kind === 'replaced') {
          return (
            <div key={`replaced-${i}`} className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground">
              <ArrowRightLeftIcon className="size-3 shrink-0" />
              {intl.formatMessage(
                { id: 'editor.agentStream.replaced', defaultMessage: 'Handed from {from} to {to} — starting over' },
                { from: item.from, to: item.to },
              )}
            </div>
          );
        }
        if (item.kind === 'steer') {
          return (
            <div
              key={`steer-${i}`}
              className="flex items-start gap-1.5 rounded-md bg-row-selected px-1.5 py-1 text-xs text-foreground"
            >
              <CornerDownRightIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
              <span className="whitespace-pre-wrap break-words">{item.text}</span>
            </div>
          );
        }
        const tc = item.toolCallId ? toolById.get(item.toolCallId) : undefined;
        return tc ? <ToolRow key={`tool-${i}`} tc={tc} /> : null;
      })}
      {state.error && <div className="text-xs text-destructive">{state.error}</div>}
    </div>
  );
}
