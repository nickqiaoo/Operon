import { useEffect, useMemo, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import {
  Workflow as WorkflowIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2,
  CheckIcon,
  XIcon,
  CircleIcon,
  CircleAlert as CircleAlertIcon,
  Square as StopIcon,
  Clock as ClockIcon,
  FileCode2,
} from 'lucide-react';
import type { BundledLanguage } from 'shiki';
import { cn } from '@/lib/utils';
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockFilename,
  CodeBlockCopyButton,
} from '@/components/ai-elements/code-block';
import { api, type WorkflowRunView, type WorkflowAgentView } from '@/lib/api';
import {
  AgentStreamView,
  INITIAL_AGENT_STREAM_STATE,
  reduceAgentChunk,
  type AgentStreamState,
} from './agent-stream';
import { WorkflowApprovalPrompt } from './WorkflowRunsWatcher';
import { MarkdownRenderer } from '@/components/ui/markdown-renderer';

/**
 * One workflow run, rendered for the panel — where there is actual room.
 *
 * The old card was shaped for a popover above the composer: everything squeezed
 * into a few dense lines, phases listed separately from a flat agent list, and
 * nothing about the thing that makes this workflow different from a single-model
 * one — WHICH agent ran each step, on what, for how long. In a full-height panel
 * that reads as an empty box.
 *
 * So: a header with the run's vital signs, agents grouped under the phase they
 * belong to (the structure the script actually declared), each row carrying its
 * agent, duration and result preview, expandable to its full stream. The final
 * result is shown here too — it used to exist only in the conversation the run
 * reported back to.
 */

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}

function AgentStateIcon({ state }: { state: WorkflowAgentView['state'] }) {
  if (state === 'done') return <CheckIcon className="h-3.5 w-3.5 shrink-0 text-status-ok" />;
  if (state === 'error') return <XIcon className="h-3.5 w-3.5 shrink-0 text-status-error" />;
  if (state === 'running') return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-status-info" />;
  return <CircleIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />;
}

function RunStatusBadge({ run, waiting }: { run: WorkflowRunView | null; waiting: number }) {
  const status = run?.status ?? 'running';
  // "Waiting on you" outranks running: the run has stopped making progress and
  // will time out unless someone answers.
  if (waiting > 0) {
    return (
      <span className="flex items-center gap-1 text-xs text-status-warn">
        <CircleAlertIcon className="h-3.5 w-3.5" />
        <FormattedMessage id="editor.workflow.waitingOnYou" defaultMessage="waiting on you" />
        {waiting > 1 ? ` (${waiting})` : ''}
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span className="flex items-center gap-1 text-xs text-status-info">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <FormattedMessage id="editor.workflow.running" defaultMessage="running" />
      </span>
    );
  }
  if (status === 'completed') {
    return (
      <span className="flex items-center gap-1 text-xs text-status-ok">
        <CheckIcon className="h-3.5 w-3.5" />
        <FormattedMessage id="editor.workflow.completed" defaultMessage="completed" />
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="flex items-center gap-1 text-xs text-status-error">
        <XIcon className="h-3.5 w-3.5" />
        <FormattedMessage id="editor.workflow.failed" defaultMessage="failed" />
      </span>
    );
  }
  if (status === 'interrupted') {
    return (
      <span className="text-xs text-status-warn">
        <FormattedMessage id="editor.workflow.interrupted" defaultMessage="interrupted" />
      </span>
    );
  }
  return (
    <span className="text-xs text-muted-foreground">
      <FormattedMessage id="editor.workflow.stopped" defaultMessage="stopped" />
    </span>
  );
}

/** A small labelled figure in the header strip. */
function Stat({ label, value, tone }: { label: React.ReactNode; value: string; tone?: 'ok' | 'error' | 'info' }) {
  return (
    <div className="min-w-0">
      <div
        className={cn(
          'text-sm font-semibold tabular-nums',
          tone === 'ok' && 'text-status-ok',
          tone === 'error' && 'text-status-error',
          tone === 'info' && 'text-status-info',
        )}
      >
        {value}
      </div>
      <div className="truncate text-[11px] text-muted-foreground/70">{label}</div>
    </div>
  );
}

/**
 * The run's numbers on one line, for the collapsed row.
 *
 * The expanded card gives each of these a labelled tile, which is right when a
 * run is what you are looking at and wrong when it is one of ten rows you are
 * scanning — four tiles plus their labels took more vertical space than the run's
 * name, description and status combined.
 */
function InlineStats({
  agents,
  counts,
  duration,
}: {
  agents: number
  counts: { done: number; failed: number }
  duration: string | null
}) {
  if (agents === 0 && !duration) return null
  return (
    <span className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-muted-foreground/70">
      {agents > 0 && (
        <span>
          {counts.done}/{agents}
        </span>
      )}
      {counts.failed > 0 && <span className="text-status-error">{counts.failed}✗</span>}
      {duration && <span>{duration}</span>}
    </span>
  )
}

/** The script the run was launched with — fetched only when opened. */
function ScriptSection({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [script, setScript] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || script != null) return;
    let cancelled = false;
    setLoading(true);
    void api
      .aiWorkflowScript(runId)
      .then((res) => {
        if (!cancelled) setScript(res.script ?? '');
      })
      .catch(() => {
        if (!cancelled) setScript('');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `script` is deliberately out of the deps: it is what this effect sets, and
    // including it would re-run the effect, cancel it, and strand `loading` on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runId]);

  const lines = script ? script.split('\n').length : 0;

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <FileCode2 className="h-3.5 w-3.5 shrink-0" />
        <span>
          {open ? (
            <FormattedMessage id="editor.workflow.hideScript" defaultMessage="Hide script" />
          ) : (
            <FormattedMessage id="editor.workflow.viewScript" defaultMessage="View script" />
          )}
          {open && lines > 0 && (
            <span className="text-muted-foreground/50">
              {' '}
              <FormattedMessage
                id="editor.workflow.scriptLines"
                defaultMessage="({count, plural, one {# line} other {# lines}})"
                values={{ count: lines }}
              />
            </span>
          )}
        </span>
        <ChevronDownIcon
          className={cn('ml-auto h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open &&
        (loading ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60">
            <Loader2 className="h-3 w-3 animate-spin" />
            <FormattedMessage id="editor.workflow.loadingScript" defaultMessage="loading script…" />
          </div>
        ) : script ? (
          <CodeBlock code={script} language={'javascript' as BundledLanguage}>
            <CodeBlockHeader>
              <CodeBlockFilename>workflow.js</CodeBlockFilename>
              <CodeBlockCopyButton />
            </CodeBlockHeader>
          </CodeBlock>
        ) : (
          <div className="text-[11px] text-muted-foreground/60">
            <FormattedMessage
              id="editor.workflow.scriptUnavailable"
              defaultMessage="This run's script is no longer stored."
            />
          </div>
        ))}
    </div>
  );
}

/** One agent: who ran it, how long it took, what came back — expandable to its stream. */
function AgentRow({
  runId,
  agent,
  stream,
}: {
  runId: string | undefined;
  agent: WorkflowAgentView;
  stream: AgentStreamState | undefined;
}) {
  const [open, setOpen] = useState(false);
  // A finished run has no live frames left, but the node recorded them. Replay
  // through the SAME reducer the live stream uses, so there is only ever one
  // rendering of an agent's work. Fetched on expand — a run can have many agents
  // and their transcripts are the bulk of it.
  const [replay, setReplay] = useState<{ state: AgentStreamState; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  // Only inputs that stay put for the lifetime of the request may gate this. It
  // used to also depend on `loading`/`replay`, which the effect itself sets — so
  // starting the fetch immediately re-ran the effect, the cleanup marked it
  // cancelled, and `finally` then skipped `setLoading(false)`: the row sat on
  // "loading transcript…" forever even though the response had arrived.
  const wantsReplay = open && !stream && runId != null;
  useEffect(() => {
    if (!wantsReplay || runId == null) return;
    let cancelled = false;
    setLoading(true);
    void api
      .aiWorkflowAgentChunks(runId, agent.index)
      .then(({ chunks, truncated }) => {
        if (cancelled) return;
        const state = chunks.reduce<AgentStreamState>(
          (acc, chunk) => reduceAgentChunk(acc, chunk as Record<string, unknown>),
          INITIAL_AGENT_STREAM_STATE,
        );
        setReplay({ state, truncated });
      })
      .catch(() => {
        if (!cancelled) setReplay({ state: INITIAL_AGENT_STREAM_STATE, truncated: false });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [wantsReplay, runId, agent.index]);
  const elapsed =
    agent.startedAt != null ? (agent.endedAt ?? (agent.state === 'running' ? Date.now() : undefined)) : undefined;
  const duration = elapsed != null && agent.startedAt != null ? formatDuration(elapsed - agent.startedAt) : null;

  return (
    <div className="rounded-lg border border-border/40 bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/50"
      >
        {open ? (
          <ChevronDownIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        ) : (
          <ChevronRightIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        )}
        <AgentStateIcon state={agent.state} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-xs font-medium text-foreground/90">{agent.label}</span>
            {agent.agentType && (
              <span className="rounded border border-border/50 px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                {agent.agentType}
              </span>
            )}
            {duration && (
              <span className="flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground/70">
                <ClockIcon className="h-3 w-3" />
                {duration}
              </span>
            )}
          </div>
          {/* The one-line answer, so the common case needs no expanding at all. */}
          {agent.error ? (
            <div className="mt-1 line-clamp-2 text-[11px] text-status-error">{agent.error}</div>
          ) : agent.resultPreview ? (
            <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{agent.resultPreview}</div>
          ) : null}
        </div>
      </button>
      {open && (
        <div className="border-t border-border/40 px-2.5 py-1.5">
          {agent.modelId && (
            <div className="pb-1 font-mono text-[10px] text-muted-foreground/60">{agent.modelId}</div>
          )}
          {/* `replay` outranks `loading`: once the transcript is in hand it is
              what the user wants to see, whatever the in-flight flag says. */}
          {stream ? (
            <AgentStreamView state={stream} />
          ) : replay ? (
            <>
              {replay.truncated && (
                <div className="pb-1 text-[11px] text-status-warn">
                  <FormattedMessage
                    id="editor.workflow.transcriptTruncated"
                    defaultMessage="This agent produced more output than is kept; the tail is missing."
                  />
                </div>
              )}
              <AgentStreamView state={replay.state} />
            </>
          ) : loading ? (
            <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground/60">
              <Loader2 className="h-3 w-3 animate-spin" />
              <FormattedMessage id="editor.workflow.loadingTranscript" defaultMessage="loading transcript…" />
            </div>
          ) : (
            <AgentStreamView state={INITIAL_AGENT_STREAM_STATE} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * There is deliberately no per-row close button.
 *
 * The panel is a list of RECENT runs, not an inbox: it is bounded by the node's
 * retention and by the list limit, so rows age out on their own. A close button
 * only added a way to lose a run you might want, sitting one pixel from the
 * tab's own close button and looking exactly like it.
 */
export function WorkflowRunDetail({
  run,
  fallbackName,
  agentStreams,
  defaultOpen = true,
}: {
  run: WorkflowRunView | null;
  fallbackName: string;
  /**
   * Per-agent live stream state, keyed by agent index. Empty for a run restored
   * from the durable list — each row then replays its recorded transcript on
   * expand, so a finished run shows the same detail a live one does.
   */
  agentStreams: Map<number, AgentStreamState>;
  defaultOpen?: boolean;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(defaultOpen);
  const [result, setResult] = useState<string | null>(null);

  const status = run?.status ?? 'running';
  const name = run?.name ?? fallbackName;
  const agents = run?.agents ?? [];
  const waiting = run?.pendingApprovals?.length ?? 0;

  const counts = useMemo(
    () => ({
      done: agents.filter((a) => a.state === 'done').length,
      running: agents.filter((a) => a.state === 'running' || a.state === 'queued').length,
      failed: agents.filter((a) => a.state === 'error').length,
    }),
    [agents],
  );

  /** Distinct agents this run actually used — the headline fact about a workflow. */
  const agentTypes = useMemo(
    () => [...new Set(agents.map((a) => a.agentType).filter(Boolean))] as string[],
    [agents],
  );

  // Group agents under the phase they declared. Anything unphased lands in a
  // trailing group rather than being dropped, so the list always totals up.
  const groups = useMemo(() => {
    const byPhase = new Map<string, WorkflowAgentView[]>();
    for (const phase of run?.phases ?? []) byPhase.set(phase.title, []);
    const loose: WorkflowAgentView[] = [];
    for (const agent of agents) {
      if (agent.phase && byPhase.has(agent.phase)) byPhase.get(agent.phase)!.push(agent);
      else if (agent.phase) byPhase.set(agent.phase, [agent]);
      else loose.push(agent);
    }
    const rows = [...byPhase.entries()].map(([title, list]) => ({ title, agents: list }));
    if (loose.length > 0) rows.push({ title: '', agents: loose });
    return rows;
  }, [run?.phases, agents]);

  // The result lives in the durable row; the stream never carries it (it can be
  // large). Fetch once the run is finished and says it has one.
  useEffect(() => {
    if (!run?.hasResult || status === 'running') return
    let cancelled = false
    void api
      .aiWorkflowResult(run.runId)
      .then((res) => {
        if (cancelled || !res.hasResult || res.result === undefined) return
        setResult(typeof res.result === 'string' ? res.result : JSON.stringify(res.result, null, 2))
      })
      .catch(() => {
        // A missing result is not worth an error state; the run row still shows.
      })
    return () => {
      cancelled = true
    }
  }, [run?.runId, run?.hasResult, status]);

  const totalDuration = run ? formatDuration((run.endedAt ?? Date.now()) - run.startedAt) : null;

  return (
    <div className="group/run px-4 py-3 transition-colors hover:bg-muted/10">
      {/* Header */}
      <div className="flex items-start gap-2">
        <WorkflowIcon
          className={cn(
            'mt-0.5 h-4 w-4 shrink-0',
            waiting > 0 && 'text-status-warn',
            waiting === 0 && status === 'running' && 'text-status-info',
            status === 'completed' && 'text-status-ok',
            status === 'failed' && 'text-status-error',
          )}
        />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            'flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-1.5 py-0.5 text-left',
            // The row is the only way to fold a run open/closed; without this it
            // read as static text.
            '-mx-1.5 cursor-pointer transition-colors hover:bg-muted/50',
          )}
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold">{name}</span>
            <RunStatusBadge run={run} waiting={waiting} />
            {/* Next to the status, not pinned to the far edge: they finish the
                sentence the badge starts ("completed — 2 of 2, in 4.8s"), and a
                number floating alone against the right margin reads as unrelated
                to the run it belongs to. The labelled tiles below are for the run
                you actually opened. */}
            {!open && <InlineStats agents={agents.length} counts={counts} duration={totalDuration} />}
          </span>
          {run?.description && (
            <span className="line-clamp-2 text-xs text-muted-foreground">{run.description}</span>
          )}
        </button>
        {status === 'running' && run && (
          <button
            type="button"
            onClick={() => void api.aiWorkflowStop(run.runId)}
            className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground/50 transition-colors hover:bg-status-error/10 hover:text-status-error"
            aria-label={intl.formatMessage({ id: 'editor.workflow.stop', defaultMessage: 'Stop' })}
          >
            <StopIcon className="h-3.5 w-3.5" />
          </button>
        )}
        {/* Fold affordance. The header was clickable but said nothing about it,
            so a finished run read as static text with no way back into it. Not a
            second focusable control — the header button owns aria-expanded; this
            only mirrors its state and widens the click target. */}
        <div
          aria-hidden
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 shrink-0 cursor-pointer rounded p-1 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronDownIcon
            className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
          />
        </div>
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          {/* Vital signs — only for the run that is open. Collapsed rows get the
              same numbers inline in the header. */}
          <div className="grid grid-cols-4 gap-3 rounded-lg border border-border/40 bg-muted/10 px-3 py-2">
            <Stat
              label={<FormattedMessage id="editor.workflow.statAgents" defaultMessage="agents" />}
              value={String(agents.length)}
            />
            <Stat
              label={<FormattedMessage id="editor.workflow.statDone" defaultMessage="done" />}
              value={String(counts.done)}
              tone={counts.done > 0 ? 'ok' : undefined}
            />
            <Stat
              label={<FormattedMessage id="editor.workflow.statFailed" defaultMessage="failed" />}
              value={String(counts.failed)}
              tone={counts.failed > 0 ? 'error' : undefined}
            />
            <Stat
              label={<FormattedMessage id="editor.workflow.statElapsed" defaultMessage="elapsed" />}
              value={totalDuration ?? '—'}
            />
          </div>

          {agentTypes.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground/70">
                <FormattedMessage id="editor.workflow.ranOn" defaultMessage="ran on" />
              </span>
              {agentTypes.map((type) => (
                <span
                  key={type}
                  className="rounded border border-border/50 px-1.5 py-px font-mono text-[10px] text-muted-foreground"
                >
                  {type}
                </span>
              ))}
            </div>
          )}

          {/* Blocked sub-agents first: nothing else moves until one is answered. */}
          {run?.pendingApprovals?.map((approval) => (
            <WorkflowApprovalPrompt key={approval.approvalId} approval={approval} chatId={run.chatId} />
          ))}

          {agents.length === 0 && status === 'running' && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <FormattedMessage id="editor.workflow.starting" defaultMessage="starting…" />
            </div>
          )}

          {groups
            // A declared phase with no agents is a skeleton entry: `phase(title)`
            // only ANNOUNCES a phase, agents join it by passing `phase` to
            // `agent()`, and plenty of scripts do the first without the second.
            // While the run is going it is worth showing as "not started yet".
            // Once the run is over it is just an empty heading sitting above
            // agents that are not in it — which is exactly what it looked like.
            .filter((group) => group.agents.length > 0 || (group.title && status === 'running'))
            .map((group, i) => {
              const done = group.agents.filter((a) => a.state === 'done').length;
              const active = group.agents.some((a) => a.state === 'running' || a.state === 'queued');
              return (
                <div key={group.title || `loose-${i}`} className="space-y-1.5">
                  {group.title && (
                    <div className="flex items-center gap-2 text-xs">
                      {active ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-status-info" />
                      ) : group.agents.length > 0 && done === group.agents.length ? (
                        <CheckIcon className="h-3.5 w-3.5 shrink-0 text-status-ok" />
                      ) : (
                        // Hollow = not started. Only ever shown while the run is
                        // still going, so it can never read as "unfinished" on a
                        // run that is plainly finished.
                        <CircleIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                      )}
                      <span className="font-medium text-foreground/90">{group.title}</span>
                      {group.agents.length > 0 && (
                        <span className="tabular-nums text-muted-foreground/60">
                          {done}/{group.agents.length}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="space-y-1 pl-5">
                    {group.agents.map((agent) => (
                      <AgentRow
                        key={agent.index}
                        runId={run?.runId}
                        agent={agent}
                        stream={agentStreams.get(agent.index)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}

          {/* Final result — previously only visible in the conversation it reported to. */}
          {result != null && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-foreground/90">
                <FormattedMessage id="editor.workflow.result" defaultMessage="Result" />
              </div>
              <div className="max-h-80 overflow-y-auto rounded-lg border border-border/40 bg-muted/10 px-3 py-2">
                <MarkdownRenderer content={result} className="text-xs" />
              </div>
            </div>
          )}

          {/* Script narration. Quiet and monospaced — it is the run talking about
              itself, not reporting a problem. These lines used to be rendered
              under "Failures", in red, on runs that had succeeded. */}
          {run?.logs && run.logs.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-foreground/90">
                <FormattedMessage id="editor.workflow.logs" defaultMessage="Log" />
              </div>
              <ul className="space-y-0.5">
                {run.logs.map((line, i) => (
                  <li key={i} className="font-mono text-[11px] text-muted-foreground">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {run?.failures && run.failures.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-status-error">
                <FormattedMessage id="editor.workflow.failures" defaultMessage="Failures" />
              </div>
              <ul className="space-y-0.5">
                {run.failures.map((failure, i) => (
                  <li key={i} className="text-[11px] text-status-error/90">
                    {failure}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {run?.error && <div className="text-xs text-status-error">{run.error}</div>}

          {/* Last, and collapsed: the script explains a run you are questioning,
              which is a different job from watching one. */}
          {run && (
            <div className="border-t border-border/40 pt-2">
              <ScriptSection runId={run.runId} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
