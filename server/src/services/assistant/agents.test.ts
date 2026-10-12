import { describe, expect, it, vi } from 'vitest'

// The user's own services, as Settings → MCP and the plugins would give them.
vi.mock('../mcp-config.js', () => ({
  withApiToken: (url: string) => url,
  mcpCliName: (id: string) => ({ codex: 'codex', 'claude-code': 'claude-code', custom: 'operon' })[id],
  userMcpServersForCli: () => ({
    'plugin-linear': { type: 'http', url: 'http://127.0.0.1/api/mcp-gateway/plugin-linear' },
    node_repl: { command: '/somewhere/node_repl' },
  }),
}))

const { disabledMcpServers, sessionMcpServers } = await import('./agents.js')

const worker = { role: 'worker' as const, id: 'w1' }

describe('assistant session servers', () => {
  it("gives a worker the user's services, keeping node_repl its own", () => {
    const servers = sessionMcpServers(worker, true, 'claude-code')
    expect(Object.keys(servers)).toEqual(['plugin-linear', 'assistant_worker', 'node_repl'])
    expect(servers.node_repl).toMatchObject({ type: 'http' })
    expect(disabledMcpServers('claude-code', servers)).toEqual([])
  })

  it('keeps services away from the main agent, which does no work itself', () => {
    expect(Object.keys(sessionMcpServers({ role: 'main' }, true, 'codex'))).toEqual(['assistant'])
  })

  // The ChatGPT app puts a stdio `node_repl` in ~/.codex/config.toml; ours under the same name
  // merges into an entry with both `command` and `url`, and Codex refuses to start the session.
  it('renames node_repl on Codex and switches off the user config one', () => {
    const servers = sessionMcpServers(worker, true, 'codex')
    expect(Object.keys(servers)).toEqual(['plugin-linear', 'assistant_worker', 'operon_node_repl'])
    expect(disabledMcpServers('codex', servers)).toEqual(['node_repl'])
  })

  it('disables nothing when no node_repl is mounted', () => {
    const servers = sessionMcpServers(worker, false, 'codex')
    expect(Object.keys(servers)).toEqual(['plugin-linear', 'assistant_worker'])
    expect(disabledMcpServers('codex', servers)).toEqual([])
  })
})
