import { useEffect, useRef, useState } from 'react';
import { FormattedMessage } from 'react-intl';
import {
  Workflow as WorkflowIcon,
  CircleDotIcon,
  CircleCheckIcon,
  CircleXIcon,
  CircleSlashIcon,
  FileCode2,
  PanelRight as PanelRightIcon,
  XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockHighlightedContent,
  CodeBlockTitle,
} from '@/components/ui/code-block';
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
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import type { ConfirmationProps } from '@/components/ai-elements/confirmation';
import { normalizeToolState } from './toolState';
import { getToolDisplayName, type ToolPartLike } from './toolName';
import { isOperonWorkflowTool, isWorkflowToolName } from './workflowToolName';
import {
  parseWorkflowMeta,
  coerceWorkflowOutput,
  type WorkflowMeta,
} from './workflow-tool-parse';
import { openWorkflowPanel } from '@/components/app-shell/useWorkflowTab';
import { getSubagentProgress, type SubagentProgressData } from './gemini-subagent-utils';
import { SubAgentChildList, type ToolInvocationPart as SubAgentChildPart } from './SubAgentRenderer';
import { extractPermissionOptions, type PermissionOutcome } from './permission-utils';
import {
  getOptimisticPermissionOutcome,
  type OptimisticPermissionDecision,
} from './optimisticPermission';

type ProgressActivity = SubagentProgressData['recentActivity'][number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolInvocationPart = ToolPartLike & {
  state?: string;
  result?: unknown;
  output?: unknown;
  errorText?: string;
  /** Present while THIS tool call is itself waiting to be approved. */
  approval?: NonNullable<ConfirmationProps['approval']>;
  toolCallId?: string;
};

interface WorkflowToolRendererProps {
  toolPart: ToolInvocationPart;
  messageId: string;
  partIndex: number;
  /** Sub-agent tool steps spawned by this workflow (bound via parentToolCallId), if any. */
  childParts?: SubAgentChildPart[];
  onPermissionDecide?: (id: string, outcome: PermissionOutcome, updatedInput?: Record<string, unknown>) => void;
}

type WorkflowRunStatus = 'awaiting-approval' | 'launching' | 'running' | 'launched' | 'error';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isWorkflowTool(toolPart: ToolPartLike): boolean {
  return isWorkflowToolName(getToolDisplayName(toolPart));
}

// ---------------------------------------------------------------------------
// Status, as the line's description
// ---------------------------------------------------------------------------

function StatusLabel({ status }: { status: WorkflowRunStatus }) {
  // Not "launching": nothing is happening and nothing will until the user acts.
  // Showing this as launching is what made a workflow look hung for minutes.
  if (status === 'awaiting-approval') {
    return (
      <TraceDescription className="text-status-warn">
        <FormattedMessage id="editor.workflow.awaitingApproval" defaultMessage="waiting for your approval" />
      </TraceDescription>
    );
  }
  return (
    <TraceDescription>
      {status === 'running' ? <FormattedMessage id="editor.workflow.running" defaultMessage="running" />
        : status === 'launching' ? <FormattedMessage id="editor.workflow.launching" defaultMessage="launching" />
          : status === 'error' ? <FormattedMessage id="editor.workflow.failed" defaultMessage="failed" />
            : <FormattedMessage id="editor.workflow.launched" defaultMessage="launched" />}
    </TraceDescription>
  );
}

// ---------------------------------------------------------------------------
// Live activity line (one accumulated workflow progress item)
// ---------------------------------------------------------------------------

function ActivityIcon({ status }: { status: ProgressActivity['status'] }) {
  // Running reads from the line's shimmer; the turn's one spinner is the Working marker.
  if (status === 'running') return <CircleDotIcon />;
  if (status === 'error') return <CircleXIcon />;
  if (status === 'cancelled') return <CircleSlashIcon />;
  return <CircleCheckIcon />;
}

function ActivityLine({ activity }: { activity: ProgressActivity }) {
  const line = (
    <TraceLine status={activity.status === 'running' ? 'running' : activity.status === 'error' ? 'error' : undefined}>
      <TraceIcon><ActivityIcon status={activity.status} /></TraceIcon>
      <TraceTitle className={activity.type === 'tool_call' ? undefined : 'whitespace-normal'}>
        {activity.displayName || activity.content}
      </TraceTitle>
    </TraceLine>
  );
  if (!activity.output) return line;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <CodeBlock size="sm">
          <CodeBlockContent wrap className="max-h-40">{activity.output}</CodeBlockContent>
        </CodeBlock>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function WorkflowToolRenderer({ toolPart, messageId, partIndex, childParts, onPermissionDecide }: WorkflowToolRendererProps) {
  const [scriptOpen, setScriptOpen] = useState(false);

  const rawInput = (toolPart.args || toolPart.input || {}) as {
    script?: string;
    name?: string;
    scriptPath?: string;
    args?: unknown;
    resumeFromRunId?: string;
  };
  // A host agent's own `Workflow` tool renders here too. Its run is invisible to
  // us — no runId, nothing in the Workflows panel, no result delivered back — so
  // the card must say so rather than let the user wait on a panel that will stay
  // empty.
  const isHostBuiltIn = !isOperonWorkflowTool(getToolDisplayName(toolPart));
  const serverState = normalizeToolState(toolPart.state);
  // A foreground workflow streams live `isSubagentProgress` snapshots; a launched background
  // workflow returns a `{taskId,…}` result. The two never co-occur, so only one path lights up.
  const progress = getSubagentProgress(toolPart as ToolPartLike & { result?: unknown; output?: unknown });
  const output = progress ? undefined : coerceWorkflowOutput(toolPart.result ?? toolPart.output);

  const script = typeof rawInput.script === 'string' ? rawInput.script : undefined;
  const meta = script ? parseWorkflowMeta(script) : { phases: [] as WorkflowMeta['phases'] };

  // Title: meta.name (inline) → name (named workflow) → scriptPath → fallback
  const title =
    meta.name ||
    rawInput.name ||
    (rawInput.scriptPath ? rawInput.scriptPath.split('/').pop() : undefined) ||
    'workflow';

  // This tool call may itself need approving before anything runs — a workflow is
  // an ordinary MCP tool call, and most providers ask before one. That state used
  // to fall through to `launching`, so the card span a spinner while it was in fact
  // waiting on a button that was never rendered.
  const approvalId = toolPart.approval?.id ?? toolPart.toolCallId;
  const [optimisticDecision, setOptimisticDecision] = useState<OptimisticPermissionDecision | null>(null);
  const optimisticOutcome = getOptimisticPermissionOutcome(approvalId, optimisticDecision);
  // The answer has to show up NOW. The server may take a while to move this part
  // off `approval-requested` (it only does so once the tool actually runs), and a
  // button that still says "Allow" after you clicked Allow reads as broken.
  const state = optimisticOutcome && serverState === 'approval-requested'
    ? 'approval-responded'
    : serverState;
  const awaitingApproval = state === 'approval-requested';
  const baseApproval: ConfirmationProps['approval'] =
    toolPart.approval ?? (approvalId ? { id: approvalId } : undefined);
  const approval = optimisticOutcome && baseApproval
    ? { ...baseApproval, approved: optimisticOutcome !== 'deny' }
    : baseApproval;
  // Providers ship their own allow/deny wording on the input envelope; fall back to
  // the shared defaults when they do not.
  const { options: permissionOptions } = extractPermissionOptions(
    rawInput as unknown as Record<string, unknown>,
  );
  const decide = (outcome: PermissionOutcome, updatedInput?: Record<string, unknown>) => {
    if (!approvalId || !onPermissionDecide) return;
    setOptimisticDecision({ approvalId, outcome: outcome === 'deny' ? 'deny' : 'allow' });
    onPermissionDecide(approvalId, outcome, updatedInput);
  };

  // Status: approval first (nothing is running yet), then live progress, then the
  // tool part + result.
  const hasError = state === 'output-error' || !!output?.error || !!toolPart.errorText;
  const launched = state === 'output-available' || !!output?.taskId;
  const status: WorkflowRunStatus = awaitingApproval
    ? 'awaiting-approval'
    : progress
    ? (progress.state === 'completed' ? 'launched' : progress.state === 'error' ? 'error' : 'running')
    : hasError ? 'error' : launched ? 'launched' : 'launching';

  // args summary
  let argsSummary: string | undefined;
  if (Array.isArray(rawInput.args)) {
    argsSummary = `${rawInput.args.length} ${rawInput.args.length === 1 ? 'item' : 'items'}`;
  } else if (rawInput.args && typeof rawInput.args === 'object') {
    const keys = Object.keys(rawInput.args as Record<string, unknown>);
    argsSummary = keys.length > 0 ? keys.join(', ') : undefined;
  } else if (typeof rawInput.args === 'string' && rawInput.args) {
    argsSummary = rawInput.args.length > 60 ? `${rawInput.args.slice(0, 59)}…` : rawInput.args;
  }

  const description = meta.description;
  const scriptLines = script ? script.split('\n').length : 0;
  const errorText = output?.error || toolPart.errorText;

  // Live counts for the collapsed one-line summary (foreground progress only).
  // Count concrete tool steps, not phase markers or thoughts.
  const counts = progress
    ? progress.recentActivity.reduce(
        (acc, a) => {
          if (a.type !== 'tool_call' || a.id.startsWith('phase-')) return acc;
          if (a.status === 'running') acc.running += 1;
          else if (a.status === 'error') acc.failed += 1;
          else acc.done += 1;
          return acc;
        },
        { done: 0, running: 0, failed: 0 },
      )
    : null;

  // Collapse the card once the run is terminal to keep the transcript quiet;
  // keep it open while running so live progress + sub-agent approvals stay visible.
  const isRunning = status === 'launching' || status === 'running';
  const hasPendingApproval = !!childParts?.some(
    (c) => normalizeToolState((c as { state?: string }).state) === 'approval-requested',
  );
  const [open, setOpen] = useState(isRunning);
  const prevRunningRef = useRef(isRunning);
  useEffect(() => {
    const running = status === 'launching' || status === 'running';
    // On the running → terminal edge, auto-collapse (unless the user re-opened it).
    if (prevRunningRef.current && !running) setOpen(false);
    prevRunningRef.current = running;
  }, [status]);
  // Any pending approval — this call's own, or a sub-agent's — must be actionable,
  // so it can never be hidden behind a collapsed card.
  const bodyOpen = open || hasPendingApproval || awaitingApproval;

  return (
    <div key={`${messageId}-${partIndex}`} className="flex min-w-0 flex-col gap-2">
      <Trace>
        <TraceCollapsible open={bodyOpen} onOpenChange={setOpen}>
          <TraceCollapsibleTrigger>
            <TraceLine status={isRunning ? 'running' : status === 'error' ? 'error' : undefined}>
              <TraceIcon><WorkflowIcon /></TraceIcon>
              <TraceTitle>{title}</TraceTitle>
              <StatusLabel status={status} />
              {counts && (counts.done > 0 || counts.running > 0 || counts.failed > 0) && (
                <TraceDescription>
                  <FormattedMessage
                    id="editor.workflow.stepCounts"
                    defaultMessage="{done} done · {running} running"
                    values={{ done: counts.done, running: counts.running }}
                  />
                  {counts.failed > 0 && (
                    <span className="text-status-error">
                      {' · '}
                      <FormattedMessage id="editor.workflow.failedCount" defaultMessage="{count} failed" values={{ count: counts.failed }} />
                    </span>
                  )}
                </TraceDescription>
              )}
              {isHostBuiltIn && (
                <TraceDescription title="This agent's own workflow tool — it does not appear in Operon's Workflows panel.">
                  <FormattedMessage id="editor.workflow.hostBuiltIn" defaultMessage="agent's own" />
                </TraceDescription>
              )}
            </TraceLine>
          </TraceCollapsibleTrigger>

          <TraceCollapsibleContent className="flex flex-col gap-3">
            {description && <p className="text-xs">{description}</p>}

            {/* Phase skeleton (extracted from meta.phases) */}
            {meta.phases.length > 0 && (
              <Trace>
                {meta.phases.map((phase, i) => (
                  <TraceLine key={`phase-${i}`}>
                    <TraceIcon><span className="font-mono text-xs tabular-nums">{i + 1}</span></TraceIcon>
                    <TraceTitle>{phase.title}</TraceTitle>
                    {phase.detail && <TraceDescription className="min-w-0 shrink truncate">{phase.detail}</TraceDescription>}
                  </TraceLine>
                ))}
              </Trace>
            )}

            {/* Live sub-agent activity (foreground workflow progress: phases ▸ / agents / logs / result) */}
            {progress && progress.recentActivity.length > 0 && (
              <Trace>
                {progress.recentActivity
                  .filter((a) => !(meta.phases.length > 0 && a.id.startsWith('phase-')))
                  .map((a) => (
                    <ActivityLine key={a.id} activity={a} />
                  ))}
              </Trace>
            )}

            {/* Sub-agent tool steps (bound to this workflow via parentToolCallId): the
                actual tool calls, and where the user approves a sub-agent's tool. */}
            {childParts && childParts.length > 0 && onPermissionDecide && (
              <Trace>
                <SubAgentChildList childParts={childParts} onPermissionDecide={onPermissionDecide} />
              </Trace>
            )}

            {/* args / named-workflow info */}
            {(argsSummary || rawInput.scriptPath || rawInput.resumeFromRunId) && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {argsSummary && (
                  <span>
                    <span className="text-muted-foreground/60">args:</span> {argsSummary}
                  </span>
                )}
                {rawInput.scriptPath && (
                  <span className="font-mono">
                    <span className="font-sans text-muted-foreground/60">scriptPath:</span>{' '}
                    {rawInput.scriptPath}
                  </span>
                )}
                {rawInput.resumeFromRunId && (
                  <span className="font-mono">
                    <span className="font-sans text-muted-foreground/60">resume:</span>{' '}
                    {rawInput.resumeFromRunId}
                  </span>
                )}
              </div>
            )}

            {/* Script — collapsed, syntax-highlighted */}
            {script && (
              <Trace>
                <TraceCollapsible open={scriptOpen} onOpenChange={setScriptOpen}>
                  <TraceCollapsibleTrigger>
                    <TraceLine>
                      <TraceIcon><FileCode2 /></TraceIcon>
                      <TraceTitle><FormattedMessage id="editor.workflow.viewScript" defaultMessage="View script" /></TraceTitle>
                      <TraceDescription>
                        <FormattedMessage id="editor.workflow.scriptLineCount" defaultMessage="{count, plural, one {# line} other {# lines}}" values={{ count: scriptLines }} />
                      </TraceDescription>
                    </TraceLine>
                  </TraceCollapsibleTrigger>
                  <TraceCollapsibleContent>
                    <CodeBlock size="sm">
                      <CodeBlockHeader>
                        <CodeBlockTitle>{meta.name ? `${meta.name}.js` : 'workflow.js'}</CodeBlockTitle>
                        <CodeBlockActions>
                          <CodeBlockCopyButton value={script} />
                        </CodeBlockActions>
                      </CodeBlockHeader>
                      <CodeBlockHighlightedContent code={script} language="javascript" className="max-h-96" />
                    </CodeBlock>
                  </TraceCollapsibleContent>
                </TraceCollapsible>
              </Trace>
            )}

            {/* Footer — launch identifiers / error (from the tool result, if present) */}
            {errorText && (
              <CodeBlock size="sm" variant="destructive">
                <CodeBlockContent wrap className="max-h-40">{errorText}</CodeBlockContent>
              </CodeBlock>
            )}
            {(output?.taskId || output?.runId) && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground/70">
                {output?.runId && <span>runId: {output.runId}</span>}
                {output?.taskId && <span>taskId: {output.taskId}</span>}
                {/* The panel auto-opens once per run and stays closed after the user
                    closes it, so this is how a run is reached again later — including
                    long after it finished, which the panel now backfills from SQLite. */}
                {!isHostBuiltIn && output?.runId && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="ml-auto font-sans"
                    onClick={(event) => {
                      event.stopPropagation();
                      openWorkflowPanel();
                    }}
                  >
                    <PanelRightIcon />
                    <FormattedMessage id="editor.workflow.openPanel" defaultMessage="Open panel" />
                  </Button>
                )}
              </div>
            )}
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>

      {/* This call's own approval, under the line: while it is pending nothing in
          the run is happening yet. Shown only while pending, or if it was
          REJECTED — an accepted one has nothing left to say (the line already
          reads "launched"), but without the rejection a denied workflow just
          looks stuck. */}
      {onPermissionDecide && approvalId && (awaitingApproval || approval?.approved === false) && (
        <Confirmation approval={approval} state={state} icon={<WorkflowIcon className="text-muted-foreground" />}>
          <ConfirmationTitle>
            <ConfirmationRequest>
              <FormattedMessage
                id="editor.workflow.confirmRun"
                defaultMessage="Run this workflow? Its sub-agents will run on the agents named in the script."
              />
            </ConfirmationRequest>
            <ConfirmationRejected>
              <XIcon className="size-4 text-status-error" />
              <span><FormattedMessage id="editor.confirm.rejected" defaultMessage="Rejected" /></span>
            </ConfirmationRejected>
          </ConfirmationTitle>
          <ConfirmationActions data-testid="permission-dialog">
            {permissionOptions.filter((o) => o.tone === 'reject').map((opt, i) => (
              <ConfirmationAction
                key={`reject-${i}`}
                data-testid={`permission-reject-${opt.outcome}`}
                tone="reject"
                variant="outline"
                onClick={() => decide(opt.outcome, opt.updatedInput)}
              >
                {opt.label}
              </ConfirmationAction>
            ))}
            {permissionOptions.filter((o) => o.tone === 'allow').map((opt, i) => (
              <ConfirmationAction
                key={`allow-${i}`}
                data-testid={`permission-allow-${opt.outcome}`}
                tone="allow"
                variant={i === 0 ? 'default' : 'secondary'}
                onClick={() => decide(opt.outcome, opt.updatedInput)}
              >
                {opt.label}
              </ConfirmationAction>
            ))}
          </ConfirmationActions>
        </Confirmation>
      )}
    </div>
  );
}
