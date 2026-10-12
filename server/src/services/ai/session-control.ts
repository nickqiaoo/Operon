import type { AgentSession, McpControl } from '@operon/agent-runtime'

/**
 * The desktop Session panel's control calls (`method` + `params` over one HTTP
 * route), mapped onto what the session's provider offers natively:
 *
 * - Operon's own agent takes every method itself (`native.control`), MCP, cron,
 *   tasks, skills and the rest.
 * - The external agents expose MCP status (`native.mcp.list`), and Claude Code
 *   and OpenCode also reconnect / toggle servers.
 *
 * The runtime keeps these typed per provider; this table is where the panel's
 * string protocol meets them.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

type ControlFn = (method: string, params: unknown) => Promise<unknown>

function controlOf(native: unknown): ControlFn | undefined {
  if (!isRecord(native) || typeof native.control !== 'function') return undefined
  const control = native.control
  return (method, params) => Promise.resolve(control.call(native, method, params))
}

function mcpOf(native: unknown): Partial<McpControl> | undefined {
  if (!isRecord(native) || !isRecord(native.mcp)) return undefined
  return native.mcp as Partial<McpControl>
}

function readName(params: unknown): string {
  const name = isRecord(params) ? params.name : undefined
  if (typeof name !== 'string' || !name.trim()) throw new Error('MCP server name is required')
  return name.trim()
}

function readEnabled(params: unknown): boolean {
  const enabled = isRecord(params) ? params.enabled : undefined
  if (typeof enabled !== 'boolean') throw new Error('MCP enabled state is required')
  return enabled
}

/** Whether the session offers any control at all. */
export function supportsSessionControl(session: AgentSession): boolean {
  return controlOf(session.native) !== undefined || mcpOf(session.native) !== undefined
}

export async function runSessionControl(session: AgentSession, method: string, params: unknown): Promise<unknown> {
  const control = controlOf(session.native)
  if (control) return control(method, params)

  const mcp = mcpOf(session.native)
  switch (method) {
    case 'mcp.list':
      if (mcp?.list) return { servers: await mcp.list() }
      break
    case 'mcp.reconnect':
      if (mcp?.reconnect) {
        await mcp.reconnect(readName(params))
        return { ok: true }
      }
      break
    case 'mcp.toggle':
      if (mcp?.toggle) {
        await mcp.toggle(readName(params), readEnabled(params))
        return { ok: true }
      }
      break
  }
  throw new Error(`Unsupported session control method: ${method}`)
}
