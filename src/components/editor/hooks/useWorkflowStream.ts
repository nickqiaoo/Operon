import { useEffect, useState } from 'react';
import { api, type WorkflowRunView, type WorkflowFeedFrame } from '@/lib/api';
import { apiAuthHeaders } from '@/lib/api-client';
import {
  INITIAL_AGENT_STREAM_STATE,
  parseStreamChunk,
  reduceAgentChunk,
  type AgentStreamState,
} from '../components/agent-stream';

/**
 * Live state for one workflow run, from its feed (`/ai/workflow/run/:id/feed`).
 *
 * The feed carries two frame kinds and the client treats them very differently:
 *   - `run`/`sync` — a run view the NODE folded. Taken as-is. The client does not
 *     merge phases, agents or approvals any more; it used to, which meant the
 *     same fold existed twice and could disagree.
 *   - `chunk` — sub-agent output, folded here through the shared reducer.
 *
 * Reconnects resume from the last event id seen, so a dropped connection costs
 * nothing and the first connection replays everything the run has already
 * produced — including a still-running agent's earlier output, which used to be
 * lost the moment the page was refreshed.
 */
export interface WorkflowStreamState {
  run: WorkflowRunView | null;
  /** Per-agent inner stream state (tool calls / text), keyed by agent index. */
  agents: Map<number, AgentStreamState>;
  /** True once the run is confirmed gone (never reachable) — stops the spinner. */
  unavailable: boolean;
}

const TERMINAL = new Set(['completed', 'failed', 'stopped', 'interrupted']);
function isTerminal(status: string | undefined): boolean {
  return status !== undefined && TERMINAL.has(status);
}

/** Give up after this many consecutive failed connects with no frame ever seen. */
const MAX_CONNECT_FAILURES = 5;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useWorkflowStream(runId: string): WorkflowStreamState {
  const [state, setState] = useState<WorkflowStreamState>({ run: null, agents: new Map(), unavailable: false });

  useEffect(() => {
    let stopped = false;
    let unavailable = false;
    /** Log position; replayed from here after a drop. */
    let cursor: number | undefined;
    const runRef: { current: WorkflowRunView | null } = { current: null };
    const agentsRef = new Map<number, AgentStreamState>();

    const publish = () => {
      if (stopped) return;
      setState({ run: runRef.current, agents: new Map(agentsRef), unavailable });
    };

    const applyFrame = (frame: WorkflowFeedFrame) => {
      if (typeof frame.id === 'number') cursor = frame.id;
      switch (frame.t) {
        case 'sync':
          if (frame.run) runRef.current = frame.run;
          break;
        case 'run':
          runRef.current = frame.run;
          break;
        case 'chunk': {
          const prev = agentsRef.get(frame.index) ?? INITIAL_AGENT_STREAM_STATE;
          agentsRef.set(
            frame.index,
            frame.chunks.reduce<AgentStreamState>(
              (acc, chunk) => reduceAgentChunk(acc, chunk as Record<string, unknown>),
              prev,
            ),
          );
          break;
        }
        default:
          return;
      }
      publish();
    };

    let connectFailures = 0;

    const connect = async () => {
      // Reconnect across transient drops; stop once terminal or unmounted.
      while (!stopped && !isTerminal(runRef.current?.status)) {
        try {
          const url = await api.aiWorkflowRunFeedUrl(runId, cursor);
          const response = await fetch(url, { headers: apiAuthHeaders() });
          if (!response.ok || !response.body) {
            // 404 = the run is not in the log (just launched, or pruned). Retry a
            // few times; if no frame has ever arrived, surface unavailable.
            connectFailures += 1;
            if (!runRef.current && connectFailures >= MAX_CONNECT_FAILURES) {
              unavailable = true;
              publish();
              return;
            }
            await delay(1500);
            continue;
          }
          connectFailures = 0;

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (!stopped) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              const frame = parseStreamChunk(line);
              if (frame) applyFrame(frame as unknown as WorkflowFeedFrame);
            }
          }
        } catch {
          // transient network/stream error — fall through to reconnect
        }
        if (!stopped && !isTerminal(runRef.current?.status)) await delay(1500);
      }
    };

    void connect();
    return () => {
      stopped = true;
    };
  }, [runId]);

  return state;
}
