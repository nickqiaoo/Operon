import type { StepResultPerformance } from 'ai'

/**
 * `performance` metrics for a `finish-step` part we did not time.
 *
 * AI SDK v7 made `performance` required on `TextStreamFinishStepPart`.
 * `streamText` fills it from its own request timers, but our providers
 * translate an external CLI's event stream — there is no request we clocked,
 * so every rate is reported as zero/unknown rather than invented.
 */
export const UNMEASURED_STEP_PERFORMANCE: StepResultPerformance = {
  effectiveOutputTokensPerSecond: 0,
  outputTokensPerSecond: undefined,
  inputTokensPerSecond: undefined,
  effectiveTotalTokensPerSecond: 0,
  stepTimeMs: 0,
  responseTimeMs: 0,
  toolExecutionMs: {},
  timeToFirstOutputMs: undefined,
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const toFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const parseContextUsage = (value: unknown): Record<string, number> | undefined => {
  if (!isRecord(value)) return undefined

  const promptTokens = toFiniteNumber(value.promptTokens)
  if (promptTokens === undefined || promptTokens <= 0) return undefined

  const contextWindow = toFiniteNumber(value.contextWindow)
  const percentUsed = toFiniteNumber(value.percentUsed)
  const numTurns = toFiniteNumber(value.numTurns)

  const contextUsage: Record<string, number> = { promptTokens }
  if (contextWindow !== undefined && contextWindow > 0) contextUsage.contextWindow = contextWindow
  if (percentUsed !== undefined && percentUsed >= 0) contextUsage.percentUsed = percentUsed
  if (numTurns !== undefined && numTurns > 0) contextUsage.numTurns = numTurns
  return contextUsage
}

const parseStringOrNull = (value: unknown): string | null | undefined => {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : value === null ? null : undefined
}

const parseBooleanOrUndefined = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

const parseAccount = (
  value: unknown
): Record<string, unknown> | null | undefined => {
  if (value === null) return null
  if (!isRecord(value) || typeof value.type !== 'string') return undefined
  if (value.type === 'apiKey') {
    return { type: 'apiKey' }
  }
  if (value.type === 'chatgpt' && typeof value.email === 'string' && typeof value.planType === 'string') {
    return {
      type: 'chatgpt',
      email: value.email,
      planType: value.planType,
    }
  }
  return undefined
}

const parseRateLimitWindow = (
  value: unknown
): Record<string, number | null> | null | undefined => {
  if (value === null) return null
  if (!isRecord(value)) return undefined

  const usedPercent = toFiniteNumber(value.usedPercent)
  if (usedPercent === undefined) return undefined

  const windowDurationMins =
    value.windowDurationMins === null ? null : toFiniteNumber(value.windowDurationMins)
  const resetsAt = value.resetsAt === null ? null : toFiniteNumber(value.resetsAt)

  if (value.windowDurationMins !== null && windowDurationMins === undefined) return undefined
  if (value.resetsAt !== null && resetsAt === undefined) return undefined

  return {
    usedPercent,
    windowDurationMins: windowDurationMins ?? null,
    resetsAt: resetsAt ?? null,
  }
}

const parseCreditsSnapshot = (
  value: unknown
): Record<string, unknown> | null | undefined => {
  if (value === null) return null
  if (!isRecord(value)) return undefined

  const hasCredits = parseBooleanOrUndefined(value.hasCredits)
  const unlimited = parseBooleanOrUndefined(value.unlimited)
  const balance = parseStringOrNull(value.balance)

  if (hasCredits === undefined || unlimited === undefined || balance === undefined) return undefined

  return { hasCredits, unlimited, balance }
}

const parseRateLimitSnapshot = (
  value: unknown
): Record<string, unknown> | null | undefined => {
  if (value === null) return null
  if (!isRecord(value)) return undefined

  const limitId = parseStringOrNull(value.limitId)
  const limitName = parseStringOrNull(value.limitName)
  const primary = parseRateLimitWindow(value.primary)
  const secondary = parseRateLimitWindow(value.secondary)
  const credits = parseCreditsSnapshot(value.credits)
  const planType = parseStringOrNull(value.planType)

  if (
    limitId === undefined ||
    limitName === undefined ||
    primary === undefined ||
    secondary === undefined ||
    credits === undefined ||
    planType === undefined
  ) {
    return undefined
  }

  return {
    limitId,
    limitName,
    primary,
    secondary,
    credits,
    planType,
  }
}

const parseRateLimitsByLimitId = (
  value: unknown
): Record<string, Record<string, unknown>> | null | undefined => {
  if (value === null) return null
  if (!isRecord(value)) return undefined

  const entries = Object.entries(value)
  const parsedEntries: Array<[string, Record<string, unknown>]> = []
  for (const [key, snapshot] of entries) {
    const parsed = parseRateLimitSnapshot(snapshot)
    if (!parsed) return undefined
    parsedEntries.push([key, parsed])
  }

  return Object.fromEntries(parsedEntries)
}

const findNestedMetadata = (metadata: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(metadata)) return undefined

  if (
    'account' in metadata ||
    'rateLimits' in metadata ||
    'rateLimitsByLimitId' in metadata ||
    'authMode' in metadata ||
    'planType' in metadata ||
    'requiresOpenaiAuth' in metadata
  ) {
    return metadata
  }

  for (const value of Object.values(metadata)) {
    if (!isRecord(value)) continue
    if (
      'account' in value ||
      'rateLimits' in value ||
      'rateLimitsByLimitId' in value ||
      'authMode' in value ||
      'planType' in value ||
      'requiresOpenaiAuth' in value
    ) {
      return value
    }
  }

  return undefined
}

export const getSessionIdFromProviderMetadata = (metadata: unknown): string | undefined => {
  if (!isRecord(metadata)) return undefined

  const directSessionId = metadata.sessionId
  if (typeof directSessionId === 'string' && directSessionId.trim()) {
    return directSessionId.trim()
  }

  for (const value of Object.values(metadata)) {
    if (!isRecord(value)) continue
    const sessionId = value.sessionId
    if (typeof sessionId === 'string' && sessionId.trim()) {
      return sessionId.trim()
    }
  }

  return undefined
}

export const getCompactedFromProviderMetadata = (
  metadata: unknown
): Record<string, unknown> | undefined => {
  if (!isRecord(metadata)) return undefined

  for (const value of Object.values(metadata)) {
    if (!isRecord(value)) continue
    if (isRecord(value.compacted)) return value.compacted
    if (value.compacted === true) return { compacted: true }
  }

  return undefined
}

export const getContextUsageFromProviderMetadata = (
  metadata: unknown
): Record<string, number> | undefined => {
  if (!isRecord(metadata)) return undefined

  const direct = parseContextUsage(metadata.contextUsage)
  if (direct) return direct

  for (const value of Object.values(metadata)) {
    if (!isRecord(value)) continue
    const nested = parseContextUsage(value.contextUsage)
    if (nested) return nested
  }

  return undefined
}

export const getCodexAccountFromProviderMetadata = (
  metadata: unknown
): Record<string, unknown> | undefined => {
  const nested = findNestedMetadata(metadata)
  if (!nested) return undefined

  const account = parseAccount(nested.account)
  const requiresOpenaiAuth = parseBooleanOrUndefined(nested.requiresOpenaiAuth)
  const authMode = parseStringOrNull(nested.authMode)
  const planType = parseStringOrNull(nested.planType)

  if (
    account === undefined &&
    requiresOpenaiAuth === undefined &&
    authMode === undefined &&
    planType === undefined
  ) {
    return undefined
  }

  const result: Record<string, unknown> = {}
  if (account !== undefined) result.account = account
  if (requiresOpenaiAuth !== undefined) result.requiresOpenaiAuth = requiresOpenaiAuth
  if (authMode !== undefined) result.authMode = authMode
  if (planType !== undefined) result.planType = planType
  return result
}

export const getCodexRateLimitsFromProviderMetadata = (
  metadata: unknown
): Record<string, unknown> | undefined => {
  const nested = findNestedMetadata(metadata)
  if (!nested) return undefined

  const rateLimits = parseRateLimitSnapshot(nested.rateLimits)
  const rateLimitsByLimitId = parseRateLimitsByLimitId(nested.rateLimitsByLimitId)

  if (rateLimits === undefined && rateLimitsByLimitId === undefined) return undefined

  const result: Record<string, unknown> = {}
  if (rateLimits !== undefined) result.rateLimits = rateLimits
  if (rateLimitsByLimitId !== undefined) result.rateLimitsByLimitId = rateLimitsByLimitId
  return result
}

export const serializeFullStreamPart = (part: Record<string, unknown>): Record<string, unknown> | null => {
  const type = typeof part.type === 'string' ? part.type : ''

  switch (type) {
    case 'text-delta':
      return { type: 'text-delta', text: part.text ?? part.textDelta }
    case 'reasoning':
      return { type: 'reasoning', text: part.text ?? part.textDelta }
    case 'tool-input-start':
      return { type: 'tool-input-start', toolName: part.toolName, toolCallId: part.toolCallId }
    case 'tool-call':
      return { type: 'tool-call', toolName: part.toolName, toolCallId: part.toolCallId, input: part.input ?? part.args }
    case 'tool-result':
      return { type: 'tool-result', toolCallId: part.toolCallId, output: safeStringify(part.output), isError: part.isError }
    case 'tool-approval-request':
      return {
        type: 'tool-approval-request',
        approvalId: part.approvalId,
        toolCall: part.toolCall,
      }
    case 'tool-output-denied':
      return { type: 'tool-output-denied' }
    case 'finish-step':
      return { type: 'finish-step', providerMetadata: part.providerMetadata }
    case 'finish':
      return { type: 'finish' }
    case 'error':
      return { type: 'error', error: part.error instanceof Error ? part.error.message : String(part.error) }
    default:
      return null
  }
}

const safeStringify = (value: unknown): unknown => {
  if (value === undefined || value === null) return value
  if (typeof value === 'string') return value

  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}
