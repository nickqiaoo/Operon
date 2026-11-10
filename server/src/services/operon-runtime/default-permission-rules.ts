import type { PermissionRule } from 'operon-agents'

/**
 * How a background assistant session hands its result back. They only record into the session
 * that called them, and a prompt or a judge round trip on them can lose the finished work.
 * Exact names on purpose: a tool added to these servers later doesn't inherit the exemption.
 */
const REPORT_BACK_TOOLS = [
  'mcp__assistant_heartbeat__heartbeat_done',
  'mcp__assistant_worker__finish_task',
  'mcp__assistant_worker__report_progress',
] as const

export const DEFAULT_PERMISSION_RULES: readonly PermissionRule[] = REPORT_BACK_TOOLS.map((pattern) => ({
  decision: 'allow',
  scope: 'user',
  pattern,
  reason: 'Operon built-in: background session reporting its result',
}))

/** User-tier defaults under whatever `config.toml` says; its `deny` and `ask` rules still win. */
export function withDefaultPermissionRules(rules: readonly PermissionRule[]): readonly PermissionRule[] {
  return [...DEFAULT_PERMISSION_RULES, ...rules]
}
