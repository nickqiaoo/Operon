/**
 * Routes app-server notifications to stream emitter
 */

import type { AppServerClient } from '../app-server-client.js';
import type {
  AgentMessageDeltaNotification,
  ReasoningTextDeltaNotification,
  ReasoningSummaryTextDeltaNotification,
  ItemStartedNotification,
  ItemCompletedNotification,
  CommandExecutionRequestApprovalNotification,
  FileChangeRequestApprovalNotification,
  CommandExecutionRequestApprovalResponse,
  FileChangeRequestApprovalResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnCompletedNotification,
  TurnError,
  CommandExecution,
  FileChange,
  McpToolCall,
  WebSearch,
  CollabAgentToolCall,
} from '../protocol/index.js';
import type {
  PlanDeltaNotification,
  TurnPlanUpdatedNotification,
} from '../protocol/notifications.js';
import type {
  CommandApprovalHandler,
  FileChangeApprovalHandler,
  ToolRequestUserInputHandler,
} from '../types/index.js';
import {
  StreamEmitter,
  type CodexRateLimitSnapshot,
  type ThreadTokenUsage,
} from './stream-emitter.js';
import { ToolTracker, resolveToolName, buildToolResultPayload, isToolItem } from './tool-tracker.js';
import { safeJsonStringify } from '../converters/index.js';

type ToolItem = CommandExecution | FileChange | McpToolCall | WebSearch | CollabAgentToolCall;
type AccountUpdatedPayload = { authMode: string | null; planType: string | null };
type AccountRateLimitsUpdatedPayload = { rateLimits: CodexRateLimitSnapshot | null };

export interface NotificationRouterOptions {
  threadId: string;
  turnId: string;
  onTurnCompleted: (status: string, error?: TurnError | null) => void;
  onCommandApproval?: CommandApprovalHandler;
  onFileChangeApproval?: FileChangeApprovalHandler;
  onToolRequestUserInput?: ToolRequestUserInputHandler;
}

// ── Sub-agent activity tracking ───────────────────────────────────────

interface SubAgentActivity {
  id: string;
  type: 'thought' | 'tool_call';
  content: string;
  displayName?: string;
  description?: string;
  args?: string;
  output?: string;
  status: 'running' | 'completed' | 'error' | 'cancelled';
}

interface SubAgentTracking {
  agentName: string;
  activities: SubAgentActivity[];
  /** Set when the collab agent item/completed fires; final result deferred to turn/completed */
  finalStatus?: 'completed' | 'error';
}

function extractItemOutput(
  item: { [k: string]: unknown },
): string | undefined {
  // commandExecution
  if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput) {
    return item.aggregatedOutput;
  }
  // mcpToolCall / collabAgentToolCall
  if (item.result !== undefined && item.result !== null) {
    return typeof item.result === 'string' ? item.result : JSON.stringify(item.result);
  }
  if (item.error !== undefined && item.error !== null) {
    return typeof item.error === 'string' ? item.error : JSON.stringify(item.error);
  }
  return undefined;
}

function itemToActivity(
  item: { type: string; id: string; [k: string]: unknown },
  status: 'running' | 'completed' | 'error',
): SubAgentActivity | null {
  const t = item.type.toLowerCase();
  switch (t) {
    case 'commandexecution':
      return {
        id: item.id,
        type: 'tool_call',
        content: 'shell',
        displayName: 'Bash',
        description: typeof item.command === 'string' ? item.command : undefined,
        args: JSON.stringify({ command: item.command, cwd: item.cwd }),
        status,
      };
    case 'filechange':
      return {
        id: item.id,
        type: 'tool_call',
        content: 'edit_file',
        displayName: 'Edit',
        description: Array.isArray(item.changes) && item.changes[0]
          ? String((item.changes[0] as Record<string, unknown>).path ?? '')
          : undefined,
        args: JSON.stringify({ changes: item.changes }),
        status,
      };
    case 'mcptoolcall':
      return {
        id: item.id,
        type: 'tool_call',
        content: `mcp__${item.server}__${item.tool}`,
        displayName: typeof item.tool === 'string' ? item.tool : 'MCP Tool',
        args: JSON.stringify({ server: item.server, tool: item.tool, arguments: item.arguments }),
        status,
      };
    case 'websearch':
      return {
        id: item.id,
        type: 'tool_call',
        content: 'web_search',
        displayName: 'WebSearch',
        description: typeof item.query === 'string' ? item.query : undefined,
        args: JSON.stringify({ query: item.query }),
        status,
      };
    case 'dynamictoolcall':
      return {
        id: item.id,
        type: 'tool_call',
        content: typeof item.tool === 'string' ? item.tool : 'tool',
        displayName: typeof item.tool === 'string' ? item.tool : undefined,
        args: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments),
        status,
      };
    default:
      return null;
  }
}

export class NotificationRouter {
  private unsubscribers: (() => void)[] = [];
  private toolTracker = new ToolTracker();
  private textItemIdsWithDelta = new Set<string>();
  private reasoningItemIdsWithDelta = new Set<string>();
  private emittedToolCallIds = new Set<string>();
  private pendingApprovalRequestIds = new Set<string>();

  private planTextBuffer = '';
  private planApprovalEmitted = false;

  // Sub-agent tracking: collabCallId → tracking data
  private subAgentTracker = new Map<string, SubAgentTracking>();
  // Sub-agent threadId → collabCallId
  private threadToCollabCall = new Map<string, string>();

  constructor(
    private client: AppServerClient,
    private emitter: StreamEmitter,
    private options: NotificationRouterOptions
  ) {}

  private flushPendingApproval(itemId: string): void {
    if (!this.emittedToolCallIds.has(itemId) || !this.pendingApprovalRequestIds.has(itemId)) {
      return;
    }

    this.pendingApprovalRequestIds.delete(itemId);
    this.emitter.emitApprovalRequest(itemId);
  }

  /**
   * Start tracking a collab agent's sub-agent threads.
   */
  private startTrackingCollabAgent(item: CollabAgentToolCall): void {
    const receiverThreadIds = item.receiverThreadIds;
    if (!receiverThreadIds?.length) return;

    const agentName = item.prompt
      ? item.prompt.slice(0, 80)
      : 'Agent';

    this.subAgentTracker.set(item.id, {
      agentName,
      activities: [],
    });

    for (const tid of receiverThreadIds) {
      this.threadToCollabCall.set(tid, item.id);
    }
    // Don't emit initial progress with 0 activities — wait for sub-thread items
  }

  /**
   * Build and emit a SubagentProgress-compatible preliminary tool-result.
   */
  private emitSubAgentProgress(
    collabCallId: string,
    state: 'running' | 'completed' | 'error',
  ): void {
    const tracking = this.subAgentTracker.get(collabCallId);
    if (!tracking) return;

    this.emitter.emitToolResult(
      collabCallId,
      'codex_collab_agent',
      {
        isSubagentProgress: true,
        agentName: tracking.agentName,
        state,
        recentActivity: tracking.activities.map((a) => ({ ...a })),
      },
      false,
      true,
      state !== 'completed' && state !== 'error', // preliminary while running
    );
  }

  /**
   * Handle an item/started notification from a tracked sub-agent thread.
   */
  private handleSubAgentItemStarted(
    collabCallId: string,
    item: { type: string; id: string; [k: string]: unknown },
  ): void {
    const tracking = this.subAgentTracker.get(collabCallId);
    if (!tracking) return;

    const activity = itemToActivity(item, 'running');
    if (activity) {
      tracking.activities.push(activity);
      this.emitSubAgentProgress(collabCallId, 'running');
    }
  }

  /**
   * Handle an item/completed notification from a tracked sub-agent thread.
   */
  private handleSubAgentItemCompleted(
    collabCallId: string,
    item: { type: string; id: string; [k: string]: unknown },
  ): void {
    const tracking = this.subAgentTracker.get(collabCallId);
    if (!tracking) return;

    const output = extractItemOutput(item);
    const hasError = 'exitCode' in item && item.exitCode !== 0 && item.exitCode !== null;

    // Find existing activity by id and update status + output
    const existing = tracking.activities.find((a) => a.id === item.id);
    if (existing) {
      existing.status = hasError ? 'error' : 'completed';
      if (output) existing.output = output;
    } else {
      // Item started on sub-agent might have been missed; add as completed
      const activity = itemToActivity(item, 'completed');
      if (activity) {
        if (output) activity.output = output;
        tracking.activities.push(activity);
      }
    }

    this.emitSubAgentProgress(collabCallId, 'running');
  }

  subscribe(): void {
    const { threadId, turnId } = this.options;
    const sameThread = (a: string, b: string) => String(a) === String(b);
    const sameTurn = (a: string, b: string) => String(a) === String(b);
    const normalizeType = (type: string) => type.toLowerCase();
    const isAgentMessage = (item: { type: string }): item is { type: string; id: string; text: string } =>
      normalizeType(item.type) === 'agentmessage';
    const isReasoning = (
      item: { type: string }
    ): item is { type: string; id: string; summary: string[] | string; content: string[] | string } =>
      normalizeType(item.type) === 'reasoning';
    const isPlanItem = (item: { type: string }): item is { type: string; id: string; text: string } =>
      normalizeType(item.type) === 'plan';

    // Emit the ExitPlanMode tool call + approval request once plan is ready.
    // The frontend handles approval/denial and triggers the next turn if approved.
    const emitPlanApprovalIfNeeded = () => {
      if (this.planApprovalEmitted || !this.planTextBuffer) return;
      this.planApprovalEmitted = true;
      const planApprovalId = `plan-approval-${turnId}`;

      this.emitter.flushText();
      this.emitter.flushReasoning();
      this.emitter.emitToolInput(planApprovalId, 'ExitPlanMode', '{}', true);
      this.emitter.emitToolCall(planApprovalId, 'ExitPlanMode', '{}', true);
      this.emittedToolCallIds.add(planApprovalId);
      this.emitter.emitApprovalRequest(planApprovalId);
    };

    // Text delta handlers
    const handleTextDelta = (params: unknown) => {
      const p = params as AgentMessageDeltaNotification['params'];
      if (!sameThread(p.threadId, threadId) || !sameTurn(p.turnId, turnId)) return;
      this.textItemIdsWithDelta.add(String(p.itemId));
      this.emitter.emitTextDelta(p.delta);
    };

    this.unsubscribers.push(
      this.client.onNotification('item/agentMessage/delta', (params) => {
        this.emitter.emitRaw('item/agentMessage/delta', params);
        handleTextDelta(params);
      })
    );

    this.unsubscribers.push(
      this.client.onNotification('agentMessageDelta', (params) => {
        this.emitter.emitRaw('agentMessageDelta', params);
        handleTextDelta(params);
      })
    );

    // Reasoning delta handlers
    const handleReasoningDelta = (params: unknown, isSummary: boolean) => {
      const p =
        params as ReasoningTextDeltaNotification['params'] | ReasoningSummaryTextDeltaNotification['params'];
      if (!sameThread(p.threadId, threadId) || !sameTurn(p.turnId, turnId)) return;
      this.reasoningItemIdsWithDelta.add(String(p.itemId));
      const delta = 'delta' in p ? p.delta : '';
      this.emitter.emitReasoningDelta(delta, isSummary);
    };

    this.unsubscribers.push(
      this.client.onNotification('reasoningTextDelta', (params) => {
        this.emitter.emitRaw('reasoningTextDelta', params);
        handleReasoningDelta(params, false);
      })
    );

    this.unsubscribers.push(
      this.client.onNotification('reasoningSummaryTextDelta', (params) => {
        this.emitter.emitRaw('reasoningSummaryTextDelta', params);
        handleReasoningDelta(params, true);
      })
    );

    this.unsubscribers.push(
      this.client.onNotification('item/reasoning/textDelta', (params) => {
        this.emitter.emitRaw('item/reasoning/textDelta', params);
        handleReasoningDelta(params, false);
      })
    );

    this.unsubscribers.push(
      this.client.onNotification('item/reasoning/summaryTextDelta', (params) => {
        this.emitter.emitRaw('item/reasoning/summaryTextDelta', params);
        handleReasoningDelta(params, true);
      })
    );

    // Item started handler
    this.unsubscribers.push(
      this.client.onNotification('item/started', (params) => {
        this.emitter.emitRaw('item/started', params);
        const p = params as ItemStartedNotification['params'];
        console.log(`[NotificationRouter] item/started: itemType=${p.item?.type}, itemId=${(p.item as unknown as Record<string, unknown>)?.id}, threadId=${p.threadId} (expected=${threadId}), turnId=${p.turnId} (expected=${turnId})`);

        // Check if this is from a tracked sub-agent thread
        const collabCallId = this.threadToCollabCall.get(String(p.threadId));
        if (collabCallId) {
          const rawItem = p.item as unknown as { type: string; id: string; [k: string]: unknown };
          this.handleSubAgentItemStarted(collabCallId, rawItem);
          return;
        }

        if (!sameThread(p.threadId, threadId) || !sameTurn(p.turnId, turnId)) {
          console.log(`[NotificationRouter] item/started SKIPPED: thread/turn mismatch`);
          return;
        }
        if (!isToolItem(p.item)) {
          console.log(`[NotificationRouter] item/started SKIPPED: not a tool item (type=${p.item?.type})`);
          return;
        }

        const item = p.item as ToolItem;
        const info = this.toolTracker.start(item);
        // Close current text/reasoning blocks so subsequent deltas are shown
        // between tool calls instead of being appended to the first segment.
        this.emitter.flushText();
        this.emitter.flushReasoning();
        this.emitter.emitToolInput(item.id, info.toolName, info.input, info.dynamic);
        this.emitter.emitToolCall(item.id, info.toolName, info.input, info.dynamic);
        this.emittedToolCallIds.add(item.id);
        // AI SDK requires the tool-call to be registered before the approval
        // request arrives, otherwise streaming approval handling throws.
        this.flushPendingApproval(item.id);

        // Start tracking sub-agent threads when a collabAgentToolCall begins
        if (normalizeType(item.type) === 'collabagenttoolcall') {
          this.startTrackingCollabAgent(item as CollabAgentToolCall);
        }
      })
    );

    // Item completed handler
    this.unsubscribers.push(
      this.client.onNotification('item/completed', (params) => {
        this.emitter.emitRaw('item/completed', params);
        const p = params as ItemCompletedNotification['params'];

        // Check if this is from a tracked sub-agent thread
        const subCollabCallId = this.threadToCollabCall.get(String(p.threadId));
        if (subCollabCallId) {
          const rawItem = p.item as unknown as { type: string; id: string; [k: string]: unknown };
          this.handleSubAgentItemCompleted(subCollabCallId, rawItem);
          return;
        }

        if (!sameThread(p.threadId, threadId) || !sameTurn(p.turnId, turnId)) return;
        if (isToolItem(p.item)) {
          const item = p.item as ToolItem;
          const existing = this.toolTracker.complete(item.id);
          const resolved = existing ?? resolveToolName(item);
          const toolName = resolved.toolName;
          const dynamic = resolved.dynamic;

          // Record tool execution for stats
          const itemType = normalizeType(item.type);
          const durationMs = 'durationMs' in item ? (item.durationMs ?? undefined) : undefined;
          if (itemType === 'commandexecution') {
            this.emitter.recordToolExecution('command', durationMs);
          } else if (itemType === 'filechange') {
            this.emitter.recordToolExecution('fileChange');
          } else if (itemType === 'mcptoolcall') {
            this.emitter.recordToolExecution('mcpTool', durationMs);
          } else if (itemType === 'websearch') {
            this.emitter.recordToolExecution('webSearch');
          } else if (itemType === 'collabagenttoolcall') {
            this.emitter.recordToolExecution('collabAgent', durationMs);

            // Late-init tracking if item/started didn't have receiverThreadIds
            if (!this.subAgentTracker.has(item.id)) {
              this.startTrackingCollabAgent(item as CollabAgentToolCall);
            }

            // Don't emit final (non-preliminary) result yet — sub-agent threads
            // may still be running. Mark activities as completed and emit a
            // preliminary update. The final result is emitted at turn/completed.
            const tracking = this.subAgentTracker.get(item.id);
            if (tracking) {
              const collabItem = item as CollabAgentToolCall;
              tracking.finalStatus = collabItem.status === 'failed' ? 'error' : 'completed';
              // Only emit progress if there are activities; otherwise wait for sub-thread
              if (tracking.activities.length > 0) {
                for (const a of tracking.activities) {
                  if (a.status === 'running') a.status = 'completed';
                }
                this.emitSubAgentProgress(item.id, 'running');
              }
              return;
            }
          }

          const { result, isError } = buildToolResultPayload(item);
          this.emitter.emitToolResult(item.id, toolName, result, isError, dynamic);
          return;
        }

        if (isAgentMessage(p.item)) {
          const itemId = String(p.item.id);
          if (!this.textItemIdsWithDelta.has(itemId) && p.item.text) {
            this.emitter.emitTextDelta(p.item.text);
          }
          return;
        }

        if (isReasoning(p.item)) {
          const itemId = String(p.item.id);
          if (!this.reasoningItemIdsWithDelta.has(itemId)) {
            const summary = Array.isArray(p.item.summary)
              ? p.item.summary.join('\n')
              : p.item.summary;
            const content = Array.isArray(p.item.content)
              ? p.item.content.join('\n')
              : p.item.content;
            if (summary) this.emitter.emitReasoningDelta(summary, true);
            if (content) this.emitter.emitReasoningDelta(content, false);
          }
        }

        // Plan item: emit text if no delta was streamed
        if (isPlanItem(p.item)) {
          const itemId = String(p.item.id);
          if (!this.textItemIdsWithDelta.has(itemId) && p.item.text) {
            this.emitter.emitTextDelta(p.item.text);
          }
          // Plan completed — emit approval if turn/plan/updated hasn't triggered it
          emitPlanApprovalIfNeeded();
        }
      })
    );

    // Approval request handlers (server-initiated requests that expect a response)
    this.unsubscribers.push(
      this.client.onRequest(
        'item/commandExecution/requestApproval',
        async (params): Promise<CommandExecutionRequestApprovalResponse> => {
          this.emitter.emitRaw('item/commandExecution/requestApproval', params);
          const p = params as CommandExecutionRequestApprovalNotification['params'];
          console.log(`[NotificationRouter] commandApproval: itemId=${p.itemId}, threadId=${p.threadId} (expected=${threadId}), turnId=${p.turnId} (expected=${turnId}), emitted=${this.emittedToolCallIds.has(p.itemId)}, pendingIds=[${[...this.pendingApprovalRequestIds]}]`);

          // Emit to stream for UI display.
          if (sameThread(p.threadId, threadId) && sameTurn(p.turnId, turnId)) {
            if (!this.emittedToolCallIds.has(p.itemId)) {
              // Codex server may send requestApproval before item/started.
              // Synthesize a tool-call so the frontend can display the approval UI.
              const toolInput = safeJsonStringify({ command: p.command, cwd: p.cwd });
              this.emitter.flushText();
              this.emitter.flushReasoning();
              this.emitter.emitToolInput(p.itemId, 'exec', toolInput, true);
              this.emitter.emitToolCall(p.itemId, 'exec', toolInput, true);
              this.emittedToolCallIds.add(p.itemId);
            }
            this.emitter.emitApprovalRequest(p.itemId);
          }

          // Call user-provided handler if available
          if (this.options.onCommandApproval) {
            return this.options.onCommandApproval(p);
          }

          // Default: decline if no handler provided
          return { decision: 'decline' };
        }
      )
    );

    this.unsubscribers.push(
      this.client.onRequest(
        'item/fileChange/requestApproval',
        async (params): Promise<FileChangeRequestApprovalResponse> => {
          this.emitter.emitRaw('item/fileChange/requestApproval', params);
          const p = params as FileChangeRequestApprovalNotification['params'];

          // Emit to stream for UI display.
          if (sameThread(p.threadId, threadId) && sameTurn(p.turnId, turnId)) {
            if (!this.emittedToolCallIds.has(p.itemId)) {
              // Codex server may send requestApproval before item/started.
              // Synthesize a tool-call so the frontend can display the approval UI.
              const toolInput = safeJsonStringify({ changes: p.changes });
              this.emitter.flushText();
              this.emitter.flushReasoning();
              this.emitter.emitToolInput(p.itemId, 'patch', toolInput, true);
              this.emitter.emitToolCall(p.itemId, 'patch', toolInput, true);
              this.emittedToolCallIds.add(p.itemId);
            }
            this.emitter.emitApprovalRequest(p.itemId);
          }

          // Call user-provided handler if available
          if (this.options.onFileChangeApproval) {
            return this.options.onFileChangeApproval(p);
          }

          // Default: decline if no handler provided
          return { decision: 'decline' };
        }
      )
    );

    // AskQuestion handler (item/tool/requestUserInput) - server-initiated request
    this.unsubscribers.push(
      this.client.onRequest(
        'item/tool/requestUserInput',
        async (params): Promise<ToolRequestUserInputResponse> => {
          this.emitter.emitRaw('item/tool/requestUserInput', params);
          const p = params as ToolRequestUserInputParams;

          // Emit as a tool call with toolName AskUserQuestion so the frontend renders it
          if (sameThread(p.threadId, threadId) && sameTurn(p.turnId, turnId)) {
            // Build questions in the format AskUserQuestionRenderer expects
            const questions = p.questions.map((q) => ({
              id: q.id,
              question: q.question,
              header: q.header,
              options: (q.options ?? []).map((o) => ({
                label: o.label,
                description: o.description,
              })),
              multiSelect: false,
              isSecret: q.isSecret,
            }));

            const toolInput = JSON.stringify({ questions });

            this.emitter.flushText();
            this.emitter.flushReasoning();
            this.emitter.emitToolInput(p.itemId, 'AskUserQuestion', toolInput, true);
            this.emitter.emitToolCall(p.itemId, 'AskUserQuestion', toolInput, true);
            this.emittedToolCallIds.add(p.itemId);
            this.emitter.emitApprovalRequest(p.itemId);
          }

          let response: ToolRequestUserInputResponse;
          if (this.options.onToolRequestUserInput) {
            response = await this.options.onToolRequestUserInput(p);
          } else {
            response = { answers: {} };
          }

          // Emit tool result so the frontend transitions from approval-requested to output-available
          if (sameThread(p.threadId, threadId) && sameTurn(p.turnId, turnId)) {
            this.emitter.emitToolResult(
              p.itemId,
              'AskUserQuestion',
              { answers: response.answers } as Record<string, unknown>,
              false,
              true,
            );
          }

          return response;
        }
      )
    );

    // Plan delta handler (item/plan/delta) - streams plan text as text delta
    this.unsubscribers.push(
      this.client.onNotification('item/plan/delta', (params) => {
        this.emitter.emitRaw('item/plan/delta', params);
        const p = params as PlanDeltaNotification['params'];
        if (!sameThread(p.threadId, threadId) || !sameTurn(p.turnId, turnId)) return;
        this.textItemIdsWithDelta.add(String(p.itemId));
        this.emitter.emitTextDelta(p.delta);

        // Buffer plan text for plan approval
        this.planTextBuffer += p.delta;
      })
    );

    // Plan step progress handler (turn/plan/updated)
    // Emit as a synthetic tool call so the frontend can render it like TodoWrite
    let planStepToolEmitted = false;
    const planStepToolId = `plan-steps-${turnId}`;
    this.unsubscribers.push(
      this.client.onNotification('turn/plan/updated', (params) => {
        this.emitter.emitRaw('turn/plan/updated', params);
        const p = params as TurnPlanUpdatedNotification['params'];
        if (!sameThread(p.threadId, threadId) || !sameTurn(p.turnId, turnId)) return;

        const input = JSON.stringify({ steps: p.plan, explanation: p.explanation });

        if (!planStepToolEmitted) {
          planStepToolEmitted = true;
          this.emitter.flushText();
          this.emitter.flushReasoning();
          this.emitter.emitToolInput(planStepToolId, 'codex_plan_steps', input, true);
          this.emitter.emitToolCall(planStepToolId, 'codex_plan_steps', input, true);
          this.emittedToolCallIds.add(planStepToolId);
        }

        // Always emit a result with the latest steps so the UI updates
        this.emitter.emitToolResult(planStepToolId, 'codex_plan_steps', { steps: p.plan, explanation: p.explanation }, false, true);

        // Emit plan approval tool (once) so the user can approve/reject the plan
        emitPlanApprovalIfNeeded();
      })
    );

    // Token usage handler
    this.unsubscribers.push(
      this.client.onNotification('thread/tokenUsage/updated', (params) => {
        this.emitter.emitRaw('thread/tokenUsage/updated', params);
        const p = params as { threadId: string; turnId: string; tokenUsage: ThreadTokenUsage };
        if (!sameThread(p.threadId, threadId) || !sameTurn(p.turnId, turnId)) return;
        this.emitter.updateTokenUsage(p.tokenUsage);
      })
    );

    this.unsubscribers.push(
      this.client.onNotification('account/updated', (params) => {
        this.emitter.emitRaw('account/updated', params);
        const p = params as AccountUpdatedPayload;
        this.emitter.updateAccountSummary({
          authMode: p.authMode,
          planType: p.planType,
        });
      })
    );

    this.unsubscribers.push(
      this.client.onNotification('account/rateLimits/updated', (params) => {
        this.emitter.emitRaw('account/rateLimits/updated', params);
        const p = params as AccountRateLimitsUpdatedPayload;
        this.emitter.updateRateLimitSnapshot(p.rateLimits);
      })
    );

    // Turn completed handler
    this.unsubscribers.push(
      this.client.onNotification('turn/completed', (params) => {
        this.emitter.emitRaw('turn/completed', params);
        const p = params as TurnCompletedNotification['params'];

        // Check if this is a sub-agent thread completing
        const subThreadCollabId = this.threadToCollabCall.get(String(p.threadId));
        if (subThreadCollabId) {
          const tracking = this.subAgentTracker.get(subThreadCollabId);
          if (tracking) {
            for (const a of tracking.activities) {
              if (a.status === 'running') a.status = 'completed';
            }
            this.emitSubAgentProgress(subThreadCollabId, tracking.finalStatus ?? 'completed');
          }
          return;
        }

        if (!sameThread(p.threadId, threadId) || !sameTurn(p.turn.id, turnId)) return;

        // Emit final (non-preliminary) results for tracked collab agents with activities
        for (const [collabCallId, tracking] of this.subAgentTracker) {
          if (tracking.activities.length === 0) continue; // skip empty, wait for sub-thread
          for (const a of tracking.activities) {
            if (a.status === 'running') a.status = 'completed';
          }
          const finalState = tracking.finalStatus ?? 'completed';
          this.emitSubAgentProgress(collabCallId, finalState);
        }

        this.textItemIdsWithDelta.clear();
        this.reasoningItemIdsWithDelta.clear();
        this.options.onTurnCompleted(p.turn.status, p.turn.error);
      })
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }
}
