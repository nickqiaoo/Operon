import type { LanguageModelUsage, UIMessage } from 'ai';
import type { DetailedContextUsage } from '@/types/context-usage';

export type AuthMode = 'apikey' | 'chatgpt' | 'chatgptAuthTokens';

export type PlanType =
  | 'free'
  | 'go'
  | 'plus'
  | 'pro'
  | 'team'
  | 'business'
  | 'enterprise'
  | 'edu'
  | 'unknown';

export type Account =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string; planType: PlanType };

export type RateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type CreditsSnapshot = {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
};

export type RateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: CreditsSnapshot | null;
  planType: PlanType | null;
};

/** One Claude subscription quota window (5-hour / weekly / …). */
export type ClaudeRateLimitWindow = {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  /** Percent of the window consumed (0-100). */
  utilization?: number;
  /** Epoch timestamp when the window resets (seconds or ms). */
  resetsAt?: number;
};

/** Claude subscription plan quota snapshot, keyed by window type. */
export type ClaudeRateLimits = {
  windows: Record<string, ClaudeRateLimitWindow>;
  /** claude.ai plan ('pro' / 'max' / …) when the SDK reports it. */
  subscriptionType?: string;
};

export type ContextUsageMetadata = {
  usage?: LanguageModelUsage;
  contextUsage?: {
    promptTokens: number;
    contextWindow?: number;
    percentUsed?: number;
    numTurns?: number;
  };
  detailedContextUsage?: DetailedContextUsage;
  codexAccount?: {
    account?: Account | null;
    requiresOpenaiAuth?: boolean;
    authMode?: AuthMode | null;
    planType?: PlanType | null;
  };
  codexRateLimits?: {
    rateLimits?: RateLimitSnapshot | null;
    rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
  };
};

export type CompactedInfo = {
  id?: string;
  originalTokenCount?: number;
  newTokenCount?: number;
  compacted?: boolean;
};
export type ContextCompactionInfo = {
  id: string;
  status: 'in_progress' | 'completed';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNumberOrUndefined = (value: unknown): value is number | undefined =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value));

const isTokenDetails = (value: unknown): boolean => {
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;
  return Object.values(value).every(isNumberOrUndefined);
};

const isLanguageModelUsage = (value: unknown): value is LanguageModelUsage => {
  if (!isRecord(value)) return false;
  return (
    isNumberOrUndefined(value.inputTokens) &&
    isNumberOrUndefined(value.outputTokens) &&
    isNumberOrUndefined(value.totalTokens) &&
    isTokenDetails(value.inputTokenDetails) &&
    isTokenDetails(value.outputTokenDetails)
  );
};

const isAuthMode = (value: unknown): value is AuthMode =>
  value === 'apikey' || value === 'chatgpt' || value === 'chatgptAuthTokens';

const isPlanType = (value: unknown): value is PlanType =>
  value === 'free' ||
  value === 'go' ||
  value === 'plus' ||
  value === 'pro' ||
  value === 'team' ||
  value === 'business' ||
  value === 'enterprise' ||
  value === 'edu' ||
  value === 'unknown';

const isStringOrNullOrUndefined = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || typeof value === 'string';

const isBooleanOrUndefined = (value: unknown): value is boolean | undefined =>
  value === undefined || typeof value === 'boolean';

const isContextUsage = (
  value: unknown
): value is { promptTokens: number; contextWindow?: number; percentUsed?: number; numTurns?: number } => {
  if (!isRecord(value)) return false;
  return (
    typeof value.promptTokens === 'number' &&
    Number.isFinite(value.promptTokens) &&
    value.promptTokens > 0 &&
    isNumberOrUndefined(value.contextWindow) &&
    isNumberOrUndefined(value.percentUsed) &&
    isNumberOrUndefined(value.numTurns)
  );
};

const isAccount = (value: unknown): value is Account => {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'apiKey') return true;
  return value.type === 'chatgpt' && typeof value.email === 'string' && isPlanType(value.planType);
};

const isRateLimitWindow = (
  value: unknown
): value is NonNullable<RateLimitSnapshot['primary']> => {
  if (!isRecord(value)) return false;
  return (
    typeof value.usedPercent === 'number' &&
    Number.isFinite(value.usedPercent) &&
    (value.windowDurationMins === null || isNumberOrUndefined(value.windowDurationMins)) &&
    (value.resetsAt === null || isNumberOrUndefined(value.resetsAt))
  );
};

const isCreditsSnapshot = (
  value: unknown
): value is NonNullable<RateLimitSnapshot['credits']> => {
  if (!isRecord(value)) return false;
  return (
    typeof value.hasCredits === 'boolean' &&
    typeof value.unlimited === 'boolean' &&
    (value.balance === null || typeof value.balance === 'string')
  );
};

const isRateLimitSnapshot = (value: unknown): value is RateLimitSnapshot => {
  if (!isRecord(value)) return false;
  return (
    isStringOrNullOrUndefined(value.limitId) &&
    isStringOrNullOrUndefined(value.limitName) &&
    (value.primary === null || isRateLimitWindow(value.primary)) &&
    (value.secondary === null || isRateLimitWindow(value.secondary)) &&
    (value.credits === null || isCreditsSnapshot(value.credits)) &&
    (value.planType === null || isPlanType(value.planType))
  );
};

const isRateLimitsByLimitId = (
  value: unknown
): value is Record<string, RateLimitSnapshot> | null => {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return Object.values(value).every(isRateLimitSnapshot);
};

const isCodexAccount = (
  value: unknown
): value is NonNullable<ContextUsageMetadata['codexAccount']> => {
  if (!isRecord(value)) return false;
  return (
    (value.account === undefined || value.account === null || isAccount(value.account)) &&
    isBooleanOrUndefined(value.requiresOpenaiAuth) &&
    (value.authMode === undefined || value.authMode === null || isAuthMode(value.authMode)) &&
    (value.planType === undefined || value.planType === null || isPlanType(value.planType))
  );
};

const isCodexRateLimits = (
  value: unknown
): value is NonNullable<ContextUsageMetadata['codexRateLimits']> => {
  if (!isRecord(value)) return false;
  return (
    (value.rateLimits === undefined || value.rateLimits === null || isRateLimitSnapshot(value.rateLimits)) &&
    (value.rateLimitsByLimitId === undefined || isRateLimitsByLimitId(value.rateLimitsByLimitId))
  );
};

const isDetailedContextUsage = (value: unknown): value is DetailedContextUsage => {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.categories) &&
    typeof value.totalTokens === 'number' &&
    typeof value.maxTokens === 'number' &&
    typeof value.percentage === 'number'
  );
};

export const extractContextUsage = (message: UIMessage | undefined): ContextUsageMetadata | null => {
  if (!message || !isRecord(message.metadata)) return null;
  const metadata = message.metadata as Record<string, unknown>;
  const usage = isLanguageModelUsage(metadata.usage) ? metadata.usage : undefined;
  const contextUsage = isContextUsage(metadata.contextUsage) ? metadata.contextUsage : undefined;
  const detailedContextUsage = isDetailedContextUsage(metadata.detailedContextUsage) ? metadata.detailedContextUsage : undefined;
  const codexAccount = isCodexAccount(metadata.codexAccount) ? metadata.codexAccount : undefined;
  const codexRateLimits = isCodexRateLimits(metadata.codexRateLimits) ? metadata.codexRateLimits : undefined;

  if (!usage && !contextUsage && !detailedContextUsage && !codexAccount && !codexRateLimits) return null;
  return { usage, contextUsage, detailedContextUsage, codexAccount, codexRateLimits };
};

export const extractCompacted = (message: UIMessage | undefined): CompactedInfo | null => {
  if (!message || !isRecord(message.metadata)) return null;
  const metadata = message.metadata as Record<string, unknown>;
  if (!metadata.compacted || !isRecord(metadata.compacted)) return null;
  return metadata.compacted as CompactedInfo;
};

export const extractContextCompaction = (message: UIMessage | undefined): ContextCompactionInfo | null => {
  if (!message || !isRecord(message.metadata)) return null;
  const value = message.metadata.contextCompaction;
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  if (value.status !== 'in_progress' && value.status !== 'completed') return null;
  return { id: value.id, status: value.status };
};

const mentionPathTokenPattern = /(^|\s)@([^\s@]+)/g;

const toPathPromptText = (text: string): string =>
  text.replace(mentionPathTokenPattern, (fullMatch, leading: string, rawToken: string) => {
    const normalizedPath = rawToken.replace(/[.,;:!?)]$/, '');
    if (!normalizedPath) return fullMatch;
    const suffix = rawToken.slice(normalizedPath.length);
    return `${leading}<filepath>${normalizedPath}</filepath>${suffix}`;
  });

export const normalizeOutboundMessagePaths = (message: UIMessage | undefined): UIMessage | undefined => {
  if (!message || message.role !== 'user' || !Array.isArray(message.parts)) return message;

  let changed = false;
  const normalizedParts = message.parts.map((part) => {
    if (part.type !== 'text') return part;
    const normalizedText = toPathPromptText(part.text);
    if (normalizedText === part.text) return part;
    changed = true;
    return { ...part, text: normalizedText };
  });

  if (!changed) return message;
  return { ...message, parts: normalizedParts };
};

export const serializeMessagePayload = (message: UIMessage): string => JSON.stringify(message);

export const getCommonPrefixLength = (left: string[], right: string[]): number => {
  const maxLength = Math.min(left.length, right.length);
  let index = 0;
  while (index < maxLength && left[index] === right[index]) {
    index += 1;
  }
  return index;
};
