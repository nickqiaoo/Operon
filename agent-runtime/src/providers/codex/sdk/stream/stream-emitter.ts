/**
 * Stream emission utilities for AI SDK stream parts
 */

import type {
  LanguageModelV3StreamPart,
  LanguageModelV3FinishReason,
  LanguageModelV3Usage,
  SharedV3Warning,
  JSONObject,
  JSONValue,
} from '@ai-sdk/provider';
import { randomUUID } from 'node:crypto';

/**
 * Metadata about tool executions during a turn
 */
export interface ToolExecutionStats {
  /** Total number of tool calls executed */
  totalCalls: number;
  /** Breakdown by tool type */
  byType: {
    commands: number;
    fileChanges: number;
    mcpTools: number;
    webSearches: number;
    collabAgents: number;
  };
  /** Total execution time in milliseconds (when available) */
  totalDurationMs: number;
}

/**
 * Raw usage metadata from Codex app-server (JSON-serializable)
 *
 * Note: Codex app-server does not currently provide token counts.
 * This metadata includes what IS available from the protocol.
 *
 * Access via `usage.raw` and cast to `CodexUsageMetadata`:
 * ```typescript
 * const metadata = usage.raw as CodexUsageMetadata | undefined;
 * ```
 */
export interface CodexUsageMetadata {
  /** The model used for this turn */
  model: string;
  /** Thread identifier */
  threadId: string;
  /** Turn identifier */
  turnId: string;
  /** Turn completion status */
  status: string;
  /** Tool execution statistics */
  toolStats: ToolExecutionStats;
  /** Whether reasoning was used in this turn */
  hasReasoning: boolean;
  /** ISO timestamp when the turn completed */
  completedAt: string;
}

export type CodexAccountInfo =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string; planType: string };

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: CodexCreditsSnapshot | null;
  planType: string | null;
}

export function createUsage(metadata?: CodexUsageMetadata): LanguageModelV3Usage {
  const raw = metadata ? (JSON.parse(JSON.stringify(metadata)) as JSONObject) : undefined;
  return {
    inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 0, text: undefined, reasoning: undefined },
    raw,
  };
}

export interface TurnError {
  code?: string;
  message?: string;
  codexErrorInfo?: string;
  additionalDetails?: unknown;
}

export function mapFinishReason(status?: string, error?: TurnError | null): LanguageModelV3FinishReason {
  switch (status) {
    case 'completed':
      return { unified: 'stop', raw: status };
    case 'interrupted':
      return { unified: 'stop', raw: status };
    case 'failed':
      return { unified: 'error', raw: error ? JSON.stringify(error) : status };
    default:
      return { unified: 'other', raw: status };
  }
}

/** Token usage breakdown from Codex thread/tokenUsage/updated */
export interface TokenUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ThreadTokenUsage {
  last: TokenUsageBreakdown;
  total: TokenUsageBreakdown;
  modelContextWindow?: number | null;
}

export interface StreamEmitterOptions {
  threadId: string;
  turnId: string;
  modelId: string;
  includeRawChunks?: boolean;
}

const isInvalidStateError = (error: unknown): boolean => {
  if (!(error instanceof TypeError)) return false;
  const withCode = error as { code?: unknown };
  if (withCode.code === 'ERR_INVALID_STATE') return true;
  return typeof error.message === 'string' && error.message.includes('Invalid state');
};

export class StreamEmitter {
  private textId = randomUUID();
  private reasoningId = randomUUID();
  private textStarted = false;
  private reasoningStarted = false;
  private hadReasoning = false;
  private closed = false;

  // Tool execution tracking
  private toolStats: ToolExecutionStats = {
    totalCalls: 0,
    byType: { commands: 0, fileChanges: 0, mcpTools: 0, webSearches: 0, collabAgents: 0 },
    totalDurationMs: 0,
  };

  // Token usage from thread/tokenUsage/updated
  private latestTokenUsage: TokenUsageBreakdown | null = null;
  private modelContextWindow: number | null = null;
  private account: CodexAccountInfo | null | undefined;
  private requiresOpenaiAuth: boolean | undefined;
  private authMode: string | null | undefined;
  private accountPlanType: string | null | undefined;
  private rateLimits: CodexRateLimitSnapshot | null | undefined;
  private rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot> | null | undefined;

  constructor(
    private controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
    private options: StreamEmitterOptions
  ) {}

  private enqueue(part: LanguageModelV3StreamPart): void {
    if (this.closed) return;
    try {
      this.controller.enqueue(part);
    } catch (error) {
      if (isInvalidStateError(error)) {
        this.closed = true;
        return;
      }
      throw error;
    }
  }

  /**
   * Record a tool execution for stats tracking
   */
  recordToolExecution(toolType: 'command' | 'fileChange' | 'mcpTool' | 'webSearch' | 'collabAgent', durationMs?: number): void {
    this.toolStats.totalCalls++;
    switch (toolType) {
      case 'command':
        this.toolStats.byType.commands++;
        break;
      case 'fileChange':
        this.toolStats.byType.fileChanges++;
        break;
      case 'mcpTool':
        this.toolStats.byType.mcpTools++;
        break;
      case 'webSearch':
        this.toolStats.byType.webSearches++;
        break;
      case 'collabAgent':
        this.toolStats.byType.collabAgents++;
        break;
    }
    if (durationMs !== undefined && durationMs > 0) {
      this.toolStats.totalDurationMs += durationMs;
    }
  }

  /**
   * Update token usage from thread/tokenUsage/updated notification
   */
  updateTokenUsage(usage: ThreadTokenUsage): void {
    this.latestTokenUsage = usage.last;
    if (usage.modelContextWindow != null) {
      this.modelContextWindow = usage.modelContextWindow;
    }
  }

  updateAccountSummary(payload: { authMode: string | null; planType: string | null }): void {
    this.authMode = payload.authMode;
    this.accountPlanType = payload.planType ?? this.accountPlanType;
  }

  updateRateLimitSnapshot(snapshot: CodexRateLimitSnapshot | null): void {
    this.rateLimits = snapshot;

    if (!snapshot?.limitId) {
      return;
    }

    this.rateLimitsByLimitId = {
      ...(this.rateLimitsByLimitId ?? {}),
      [snapshot.limitId]: snapshot,
    };
  }

  emitStreamStart(warnings: SharedV3Warning[]): void {
    this.enqueue({ type: 'stream-start', warnings });
    this.enqueue({
      type: 'response-metadata',
      id: this.options.turnId,
      timestamp: new Date(),
      modelId: this.options.modelId,
    });
  }

  emitRaw(method: string, params: unknown): void {
    if (this.options.includeRawChunks) {
      this.enqueue({ type: 'raw', rawValue: { method, params } });
    }
  }

  emitTextDelta(delta: string): void {
    if (!this.textStarted) {
      this.textStarted = true;
      this.enqueue({ type: 'text-start', id: this.textId });
    }
    this.enqueue({ type: 'text-delta', id: this.textId, delta });
  }

  emitReasoningDelta(delta: string, isSummary = false): void {
    if (!this.reasoningStarted) {
      this.reasoningStarted = true;
      this.enqueue({ type: 'reasoning-start', id: this.reasoningId });
    }
    if (delta.length > 0) {
      this.hadReasoning = true;
    }
    this.enqueue({
      type: 'reasoning-delta',
      id: this.reasoningId,
      delta,
      ...(isSummary ? { providerMetadata: { codex: { isSummary: true } } } : {}),
    });
  }

  /**
   * Close the current text block so that tool calls appear between text segments
   * rather than all being grouped after a single text block.
   */
  flushText(): void {
    if (this.textStarted) {
      this.enqueue({ type: 'text-end', id: this.textId });
      this.textStarted = false;
      this.textId = randomUUID();
    }
  }

  /**
   * Close the current reasoning block so reasoning can be displayed between
   * tool calls instead of being appended to the first reasoning segment.
   */
  flushReasoning(): void {
    if (this.reasoningStarted) {
      this.enqueue({ type: 'reasoning-end', id: this.reasoningId });
      this.reasoningStarted = false;
      this.reasoningId = randomUUID();
    }
  }

  emitToolInput(toolCallId: string, toolName: string, input: string, dynamic?: boolean): void {
    this.enqueue({
      type: 'tool-input-start',
      id: toolCallId,
      toolName,
      providerExecuted: true,
      ...(dynamic ? { dynamic: true } : {}),
    });
    if (input) {
      this.enqueue({ type: 'tool-input-delta', id: toolCallId, delta: input });
    }
    this.enqueue({ type: 'tool-input-end', id: toolCallId });
  }

  emitToolCall(toolCallId: string, toolName: string, input: string, dynamic?: boolean): void {
    this.enqueue({
      type: 'tool-call',
      toolCallId,
      toolName,
      input,
      providerExecuted: true,
      ...(dynamic ? { dynamic: true } : {}),
    });
  }

  emitToolResult(
    toolCallId: string,
    toolName: string,
    result: Record<string, unknown>,
    isError?: boolean,
    dynamic?: boolean,
    preliminary?: boolean
  ): void {
    this.enqueue({
      type: 'tool-result',
      toolCallId,
      toolName,
      result: (result ?? {}) as NonNullable<JSONValue>,
      ...(isError ? { isError: true } : {}),
      ...(dynamic ? { dynamic: true } : {}),
      ...(preliminary ? { preliminary: true } : {}),
    });
  }

  emitApprovalRequest(itemId: string): void {
    this.enqueue({
      type: 'tool-approval-request',
      approvalId: itemId,
      toolCallId: itemId,
    });
  }

  emitFinish(status?: string, error?: TurnError | null): void {
    // If there's an error with a message and no text was emitted, emit error as text
    if (error?.message && !this.textStarted) {
      const errorText = error.codexErrorInfo
        ? `Error: ${error.message}\n\n${error.codexErrorInfo}`
        : `Error: ${error.message}`;
      this.emitTextDelta(errorText);
    }

    if (this.textStarted) {
      this.enqueue({ type: 'text-end', id: this.textId });
    }
    if (this.reasoningStarted) {
      this.enqueue({ type: 'reasoning-end', id: this.reasoningId });
      this.reasoningStarted = false;
    }

    // Build usage metadata with what Codex provides
    const metadata: CodexUsageMetadata = {
      model: this.options.modelId,
      threadId: this.options.threadId,
      turnId: this.options.turnId,
      status: status ?? 'unknown',
      toolStats: this.toolStats,
      hasReasoning: this.hadReasoning,
      completedAt: new Date().toISOString(),
    };

    const usage = createUsage(metadata);

    // Populate real token counts from thread/tokenUsage/updated
    if (this.latestTokenUsage) {
      usage.inputTokens = {
        total: this.latestTokenUsage.inputTokens,
        noCache: undefined,
        cacheRead: this.latestTokenUsage.cachedInputTokens || undefined,
        cacheWrite: undefined,
      };
      usage.outputTokens = {
        total: this.latestTokenUsage.outputTokens,
        text: undefined,
        reasoning: this.latestTokenUsage.reasoningOutputTokens || undefined,
      };
    }

    // Build context usage for the frontend
    // Codex/OpenAI convention: inputTokens already includes cached tokens
    // Only use inputTokens (consistent with Claude Code which also excludes output)
    const promptTokens = this.latestTokenUsage?.inputTokens ?? 0;
    const contextWindow = this.modelContextWindow ?? undefined;
    const contextUsage: Record<string, number> = {};
    if (promptTokens > 0) {
      contextUsage.promptTokens = promptTokens;
      if (contextWindow && contextWindow > 0) {
        contextUsage.contextWindow = contextWindow;
        contextUsage.percentUsed = promptTokens / contextWindow;
      }
    }

    const codexMeta: Record<string, JSONValue> = {
      sessionId: this.options.threadId,
    };
    if (Object.keys(contextUsage).length > 0) {
      codexMeta.contextUsage = contextUsage as unknown as JSONValue;
    }
    if (this.account !== undefined) {
      codexMeta.account = serializeJsonValue(this.account);
    }
    if (this.requiresOpenaiAuth !== undefined) {
      codexMeta.requiresOpenaiAuth = this.requiresOpenaiAuth;
    }
    if (this.authMode !== undefined) {
      codexMeta.authMode = this.authMode;
    }
    if (this.accountPlanType !== undefined) {
      codexMeta.planType = this.accountPlanType;
    }
    if (this.rateLimits !== undefined) {
      codexMeta.rateLimits = serializeJsonValue(this.rateLimits);
    }
    if (this.rateLimitsByLimitId !== undefined) {
      codexMeta.rateLimitsByLimitId = serializeJsonValue(this.rateLimitsByLimitId);
    }

    this.enqueue({
      type: 'finish',
      finishReason: mapFinishReason(status, error),
      usage,
      providerMetadata: { codex: codexMeta },
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.close();
    } catch (error) {
      if (isInvalidStateError(error)) return;
      throw error;
    }
  }
}

const serializeJsonValue = (value: unknown): JSONValue =>
  JSON.parse(JSON.stringify(value)) as JSONValue;
