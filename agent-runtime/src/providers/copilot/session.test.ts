import { describe, expect, it } from 'vitest'
import { toCopilotMcpServers } from './session.js'

describe('toCopilotMcpServers', () => {
  it('passes HTTP and stdio MCP servers into the Copilot SDK shape', () => {
    expect(toCopilotMcpServers({
      node_repl: {
        type: 'http',
        url: 'http://127.0.0.1:3100/api/node-repl-mcp?sessionId=42',
      },
      local: {
        command: 'node',
        args: ['server.mjs'],
        env: { TOKEN: 'test' },
      },
    })).toEqual({
      node_repl: {
        type: 'http',
        url: 'http://127.0.0.1:3100/api/node-repl-mcp?sessionId=42',
        headers: undefined,
      },
      local: {
        type: 'stdio',
        command: 'node',
        args: ['server.mjs'],
        env: { TOKEN: 'test' },
      },
    })
  })
})
