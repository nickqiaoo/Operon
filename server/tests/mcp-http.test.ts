import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { Server as HttpServer } from 'http'
import { externalAgentMcpRoutes } from '../src/routes/external-agent-mcp.js'
import { memoryMcpRoutes } from '../src/routes/memory-mcp.js'
import { workspaceChatMcpRoutes } from '../src/routes/workspace-chat-mcp.js'
import { taskBoardMcpRoutes } from '../src/routes/task-board-mcp.js'

const INITIALIZE_REQUEST = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vitest-mcp-client', version: '0.0.0' },
  },
}

interface RunningApp {
  baseUrl: string
  close: () => Promise<void>
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function startNodeApp(app: Hono): Promise<RunningApp> {
  let server: HttpServer | undefined

  const ready = new Promise<RunningApp>((resolve) => {
    server = serve(
      {
        fetch: app.fetch,
        hostname: '127.0.0.1',
        port: 0,
      },
      (info) => {
        resolve({
          baseUrl: `http://127.0.0.1:${info.port}`,
          close: () => {
            if (!server) return Promise.resolve()
            return closeServer(server)
          },
        })
      },
    )
  })

  return ready
}

async function expectInitializeJson(baseUrl: string, route: string, serverName: string) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(INITIALIZE_REQUEST),
  })

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('application/json')

  const body = await response.json() as {
    result?: { serverInfo?: { name?: string } }
  }
  expect(body.result?.serverInfo?.name).toBe(serverName)
}

async function expectInitializedNotificationHasContentType(baseUrl: string, route: string) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  })

  expect(response.status).toBe(202)
  expect(response.headers.get('content-type')).toBeTruthy()
}

async function listToolNames(baseUrl: string, route: string): Promise<string[]> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }),
  })

  expect(response.status).toBe(200)
  const body = await response.json() as {
    result?: { tools?: Array<{ name?: string }> }
  }
  return body.result?.tools?.flatMap((tool) => tool.name ? [tool.name] : []) ?? []
}

describe('HTTP MCP routes', () => {
  let running: RunningApp | null = null

  afterEach(async () => {
    await running?.close()
    running = null
  })

  it('answers initialize with direct JSON for Codex rmcp', async () => {
    const app = new Hono()
    const storage = {} as Parameters<typeof workspaceChatMcpRoutes>[0] & Parameters<typeof taskBoardMcpRoutes>[0]

    app.route('/api/external-agent-mcp', externalAgentMcpRoutes())
    app.route('/api/memory-mcp', memoryMcpRoutes())
    app.route('/api/workspace-chat-mcp', workspaceChatMcpRoutes(storage))
    app.route('/api/task-board-mcp', taskBoardMcpRoutes(storage))

    running = await startNodeApp(app)

    await expectInitializeJson(
      running.baseUrl,
      '/api/external-agent-mcp?agents=codex,claude-code',
      'external_agent',
    )
    await expectInitializedNotificationHasContentType(
      running.baseUrl,
      '/api/external-agent-mcp?agents=codex,claude-code',
    )

    await expectInitializeJson(running.baseUrl, '/api/memory-mcp', 'memory')
    await expectInitializedNotificationHasContentType(running.baseUrl, '/api/memory-mcp')

    await expectInitializeJson(
      running.baseUrl,
      '/api/workspace-chat-mcp?agentId=1&projectId=1',
      'workspace_chat',
    )
    await expectInitializedNotificationHasContentType(
      running.baseUrl,
      '/api/workspace-chat-mcp?agentId=1&projectId=1',
    )

    await expectInitializeJson(
      running.baseUrl,
      '/api/task-board-mcp?agentId=1&projectId=1',
      'taskboard',
    )
    await expectInitializedNotificationHasContentType(
      running.baseUrl,
      '/api/task-board-mcp?agentId=1&projectId=1',
    )

    const taskboardTools = await listToolNames(
      running.baseUrl,
      '/api/task-board-mcp?agentId=1&projectId=1',
    )
    expect(taskboardTools).toEqual(expect.arrayContaining([
      'list_project_tasks',
      'get_project_task',
      // create_project_task is gone: a task now enters the board through the SDD tools below,
      // so a plain "create" no longer exists to assert on.
      'create_spec_task',
      'write_artifact',
      'sediment_change',
      'dispatch_project_task',
      'update_project_task',
      'comment_project_task',
    ]))
    const legacyTaskToolNames = [
      'list_tasks',
      'get_task',
      'create_task',
      'dispatch_task',
      'update_task',
      'comment_task',
    ]
    for (const name of legacyTaskToolNames) {
      expect(taskboardTools).not.toContain(name)
    }
  })
})
