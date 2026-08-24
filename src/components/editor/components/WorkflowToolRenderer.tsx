import { useEffect, useRef, useState } from 'react';
import { FormattedMessage } from 'react-intl';
import {
  Workflow as WorkflowIcon,
  ChevronDownIcon,
  Loader2,
  CheckIcon,
  XIcon,
  FileCode2,
  ShieldQuestion as ShieldQuestionIcon,
  PanelRight as PanelRightIcon,
} from 'lucide-react';
import type { BundledLanguage } from 'shiki';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockFilename,
  CodeBlockCopyButton,
} from '@/components/ai-elements/code-block';
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import type { ConfirmationProps } from '@/components/ai-elements/confirmation';
import { cn } from '@/lib/utils';
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
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: WorkflowRunStatus }) {
  // Not a spinner: nothing is happening and nothing will until the user acts.
  // Showing this as "launching" is what made a workflow look hung for minutes.
  if (status === 'awaiting-approval') {
    return (
      <span className="flex items-center gap-1 text-xs text-status-warn">
        <ShieldQuestionIcon className="h-3.5 w-3.5" />
        <FormattedMessage id="editor.workflow.awaitingApproval" defaultMessage="waiting for your approval" />
      </span>
    );
  }
  if (status === 'launching' || status === 'running') {
    return (
      <span className="flex items-center gap-1 text-xs text-status-info">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {status === 'running'
          ? <FormattedMessage id="editor.workflow.running" defaultMessage="running" />
          : <FormattedMessage id="editor.workflow.launching" defaultMessage="launching" />}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex items-center gap-1 text-xs text-destructive">
        <XIcon className="h-3.5 w-3.5" />
        <FormattedMessage id="editor.workflow.failed" defaultMessage="failed" />
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-status-ok">
      <CheckIcon className="h-3.5 w-3.5" />
      <FormattedMessage id="editor.workflow.launched" defaultMessage="launched" />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Live activity row (one accumulated workflow progress item)
// ---------------------------------------------------------------------------

function ActivityStatusIcon({ status }: { status: ProgressActivity['status'] }) {
  if (status === 'running') return <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-status-info" />;
  if (status === 'error') return <XIcon className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />;
  if (status === 'cancelled') return <XIcon className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />;
  return <CheckIcon className="mt-0.5 h-3 w-3 shrink-0 text-status-ok" />;
}

function ActivityRow({ activity }: { activity: ProgressActivity }) {
  const label = activity.displayName || activity.content;
  return (
    <div className="flex items-start gap-2 text-xs">
      <ActivityStatusIcon status={activity.status} />
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            'whitespace-pre-wrap break-words',
            activity.type === 'tool_call' ? 'font-medium text-foreground/90' : 'text-muted-foreground',
          )}
        >
          {label}
        </span>
        {activity.output && (
          <pre className="mt-0.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground/70">
            {activity.output}
          </pre>
        )}
      </div>
    </div>
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
    <Collapsible
      open={bodyOpen}
      onOpenChange={setOpen}
      key={`${messageId}-${partIndex}`}
      className="mt-1 rounded-xl border border-border/40 bg-muted/10"
    >
      {/* Header — click to expand/collapse */}
      <CollapsibleTrigger asChild>
        {/* Padding matches WorkflowResultMessage's header: the launch card and the
            result card are the same family and usually sit next to each other, so
            a taller header on one reads as a mistake. */}
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left"
        >
          <WorkflowIcon
            className={cn(
              'h-4 w-4 shrink-0',
              status === 'launching' && 'text-status-info',
              status === 'launched' && 'text-status-ok',
              status === 'error' && 'text-destructive',
            )}
          />
          <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-xs"><FormattedMessage id="editor.workflow.badge" defaultMessage="Workflow" /></span>
          {isHostBuiltIn && (
            <span
              className="rounded border border-border/50 px-1.5 py-0.5 text-[11px] text-muted-foreground"
              title="This agent's own workflow tool — it does not appear in Operon's Workflows panel."
            >
              <FormattedMessage id="editor.workflow.hostBuiltIn" defaultMessage="agent's own" />
            </span>
          )}
          <span className="truncate text-sm font-semibold">{title}</span>
          <StatusBadge status={status} />
          {counts && (counts.done > 0 || counts.running > 0 || counts.failed > 0) && (
            <span className="text-xs text-muted-foreground/60">
              {counts.done}✓ {counts.running}⟳{counts.failed > 0 ? ` ${counts.failed}✗` : ''}
            </span>
          )}
          <ChevronDownIcon
            className={cn(
              'ml-auto h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform',
              bodyOpen && 'rotate-180',
            )}
          />
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-3 px-4 pb-4">
      {/* Description */}
      {description && <p className="text-xs text-muted-foreground">{description}</p>}

      {/* This call's own approval. FIRST in the body: while it is pending nothing
          below it is happening yet, and the run cannot start until it is answered.

          Shown only while it is pending, or if it was REJECTED. An accepted one
          has nothing left to say — `ConfirmationRequest` and `ConfirmationActions`
          both go null once answered, leaving a padded box holding the word
          "Accepted", which the header already says (✓ launched) and says better.
          A rejection stays: without it a denied workflow just looks stuck. */}
      {onPermissionDecide && approvalId && (awaitingApproval || approval?.approved === false) && (
        <Confirmation approval={approval} state={state}>
          <ConfirmationTitle>
            <ConfirmationRequest>
              <FormattedMessage
                id="editor.workflow.confirmRun"
                defaultMessage="Run this workflow? Its sub-agents will run on the agents named in the script."
              />
            </ConfirmationRequest>
            <ConfirmationRejected>
              <XIcon className="size-4 text-destructive" />
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
                variant="default"
                onClick={() => decide(opt.outcome, opt.updatedInput)}
              >
                {opt.label}
              </ConfirmationAction>
            ))}
          </ConfirmationActions>
        </Confirmation>
      )}

      {/* Phase skeleton (extracted from meta.phases) */}
      {meta.phases.length > 0 && (
        <div className="space-y-1">
          {meta.phases.map((phase, i) => (
            <div key={`phase-${i}`} className="flex items-baseline gap-2 text-xs">
              <span className="font-mono text-muted-foreground/70">{i + 1}.</span>
              <span className="font-medium text-foreground/90">{phase.title}</span>
              {phase.detail && <span className="text-muted-foreground">— {phase.detail}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Live sub-agent activity (foreground workflow progress: phases ▸ / agents / logs / result) */}
      {progress && progress.recentActivity.length > 0 && (
        <div className="space-y-1.5 border-t border-border/40 pt-3">
          {progress.recentActivity
            .filter((a) => !(meta.phases.length > 0 && a.id.startsWith('phase-')))
            .map((a) => (
              <ActivityRow key={a.id} activity={a} />
            ))}
        </div>
      )}

      {/* Sub-agent tool steps (bound to this workflow via parentToolCallId) — collapsible,
          with inline approval prompts. The progress rows above summarize; these are the
          actual tool calls (and where the user approves a sub-agent's tool). */}
      {childParts && childParts.length > 0 && onPermissionDecide && (
        <div className="space-y-1 border-t border-border/40 pt-3">
          <SubAgentChildList childParts={childParts} onPermissionDecide={onPermissionDecide} />
        </div>
      )}

      {/* args / named-workflow info */}
      {(argsSummary || rawInput.scriptPath || rawInput.resumeFromRunId) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
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
        <Collapsible open={scriptOpen} onOpenChange={setScriptOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <FileCode2 className="h-3.5 w-3.5 shrink-0" />
              <span>
                {scriptOpen
                  ? <FormattedMessage id="editor.workflow.hideScript" defaultMessage="Hide script" />
                  : <FormattedMessage id="editor.workflow.viewScript" defaultMessage="View script" />}
                <span className="text-muted-foreground/50"> <FormattedMessage id="editor.workflow.scriptLines" defaultMessage="({count, plural, one {# line} other {# lines}})" values={{ count: scriptLines }} /></span>
              </span>
              <ChevronDownIcon
                className={cn(
                  'ml-auto h-3.5 w-3.5 shrink-0 transition-transform',
                  scriptOpen && 'rotate-180',
                )}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <CodeBlock code={script} language={'javascript' as BundledLanguage}>
              <CodeBlockHeader>
                <CodeBlockFilename>{meta.name ? `${meta.name}.js` : 'workflow.js'}</CodeBlockFilename>
                <CodeBlockCopyButton />
              </CodeBlockHeader>
            </CodeBlock>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Footer — launch identifiers / error (from the tool result, if present) */}
      {(output?.taskId || output?.runId || errorText) && (
        <div className="space-y-1 border-t border-border/40 pt-2 text-xs">
          {errorText && <div className="text-destructive">{errorText}</div>}
          {(output?.taskId || output?.runId) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground/70 font-mono">
              {output?.runId && <span>runId: {output.runId}</span>}
              {output?.taskId && <span>taskId: {output.taskId}</span>}
              {/* The panel auto-opens once per run and stays closed after the user
                  closes it, so this is how a run is reached again later — including
                  long after it finished, which the panel now backfills from SQLite. */}
              {!isHostBuiltIn && output?.runId && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    openWorkflowPanel();
                  }}
                  className="ml-auto flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-sans text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <PanelRightIcon className="h-3.5 w-3.5" />
                  <FormattedMessage id="editor.workflow.openPanel" defaultMessage="Open panel" />
                </button>
              )}
            </div>
          )}
        </div>
      )}
      </CollapsibleContent>
    </Collapsible>
  );
}
