import { createServer, type Server, type IncomingMessage } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { OpenCode } from '@opencode/client'
import { createRuntimeContext } from '../../context.js'
import { OpencodeRuntimeSession, listOpencodeDescriptorModels } from './session.js'
import { OpencodeClientManager } from './client-manager.js'
import { startOpencodeServer } from './server.js'
import { OPENCODE_CALLER_ARG, writeOpencodeCallerPlugin } from './caller-identity.js'
import type { RuntimeStreamPart } from '../../types.js'

const binary = process.env.OPERON_TEST_OPENCODE_BINARY
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  return `http://127.0.0.1:${address.port}`
}
async function json(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of request) body += String(chunk)
  return JSON.parse(body) as Record<string, unknown>
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

// Opt-in: a real OpenCode process, with all model and MCP traffic kept on localhost.
it.skipIf(!binary).each([false, true])('runs V2 with usage, native switches and MCP routing (Code Mode: %s)', async (codemode) => {
  const root = mkdtempSync(path.join(tmpdir(), 'operon-opencode-v2-'))
  const calls: Record<string, unknown>[] = []
  const requests: Record<string, unknown>[] = []
  const mcp = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const message = await json(req)
    if (message.id === undefined) { res.writeHead(202).end(); return }
    let result: object = {}
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Return OK.', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: true } }] }
    if (message.method === 'tools/call') {
      const params = message.params as { arguments: Record<string, unknown> }
      calls.push(params.arguments)
      result = { content: [{ type: 'text', text: 'OK' }] }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  const llm = createServer(async (req, res) => {
    const request = await json(req)
    requests.push(request)
    const messages = request.messages as Array<{ role: string }>
    const tools = (request.tools ?? []) as Array<{ function?: { name: string } }>
    const tool = tools.find((entry) => codemode ? entry.function?.name === 'execute' : entry.function?.name.endsWith('echo'))?.function?.name
    const useTool = tool && !messages.some((message) => message.role === 'tool')
    const usage = { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42, prompt_tokens_details: { cached_tokens: 5 } }
    if (request.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta: object, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage } : {}) })}\n\n`)
    chunk({ role: 'assistant' })
    if (useTool) {
      const args = codemode ? { code: 'console.log(await tools.node_repl.echo({ message: "hello" }))' } : { message: 'hello' }
      chunk({ tool_calls: [{ index: 0, id: 'echo-call', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] })
      chunk({}, 'tool_calls')
    } else {
      chunk({ content: 'OK' })
      chunk({}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  })
  const mcpUrl = await listen(mcp)
  const llmUrl = await listen(llm)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  const server = await startOpencodeServer({
    binary: binary!, env: { ...env, OPENCODE_CONFIG_DIR: root, OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true' },
    hostname: '127.0.0.1', port: 0, timeout: 15_000,
    config: {
      plugins: [writeOpencodeCallerPlugin()], enabled_providers: ['operon-fixture'], model: 'operon-fixture/fixture', compaction: { auto: false },
      commands: { 'fixture/check': { description: 'Check fixture input', template: 'Inspect $ARGUMENTS.' } },
      providers: { 'operon-fixture': { name: 'Fixture Provider', package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: `${llmUrl}/v1`, apiKey: 'fixture' }, models: {
        fixture: { name: 'Fixture', limit: { context: 262144, output: 512 }, capabilities: { tools: true }, variants: [{ id: 'low' }, { id: 'high' }] },
        'fixture-2': { name: 'Fixture 2', limit: { context: 262144, output: 512 }, capabilities: { tools: true }, variants: [{ id: 'low' }, { id: 'high' }] },
      } } },
    },
  })
  const client = OpenCode.make({ baseUrl: server.url, headers: server.headers })
  const ctx = createRuntimeContext()
  Object.assign(OpencodeClientManager.getInstance(ctx), { getClient: async () => client })
  const session = new OpencodeRuntimeSession({ cwd: root, model: 'operon-fixture/fixture', effort: 'low', instructions: 'Operon fixture instructions', opencode: { callerTag: 'test-chat' } }, ctx)
  try {
    await client.mcp.add({ server: 'node_repl', location: { directory: root }, config: { type: 'remote', url: mcpUrl, codemode } })
    const descriptor = await listOpencodeDescriptorModels(ctx, root, 'operon-fixture/fixture')
    expect(descriptor.models).toContainEqual(expect.objectContaining({ id: 'operon-fixture/fixture', providerLabel: 'Fixture Provider' }))
    expect(await OpencodeClientManager.getInstance(ctx).listCommands(root)).toContainEqual({ name: 'fixture/check', description: 'Check fixture input' })
    const parts: RuntimeStreamPart[] = []
    for await (const part of session.send('/fixture/check src/auth.ts "error handling"', { signal: AbortSignal.timeout(15_000) })) {
      parts.push(part)
      if (part.type === 'tool-approval-request') session.respond(part.approvalId, { type: 'allow' })
      if (part.type === 'text-delta') await session.set({ model: 'operon-fixture/fixture-2', mode: 'plan', effort: 'high' })
    }
    const errors = parts.filter((part) => part.type === 'error')
    expect(errors.map((part) => String(part.error))).toEqual([])
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish', finishReason: 'stop' }))
    expect(parts).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'OK' }))
    expect(calls[0]?.[OPENCODE_CALLER_ARG]).toBe(session.id)
    if (codemode) expect(parts).toContainEqual(expect.objectContaining({ type: 'tool-result', toolName: 'node_repl_echo', output: 'OK' }))
    const usage = await session.contextUsage()
    expect(usage).toEqual(expect.objectContaining({ maxTokens: 262144, totalTokens: 40, isAutoCompactEnabled: false }))
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish', totalUsage: expect.objectContaining({ inputTokens: 80, outputTokens: 4 }) }))
    expect(requests.length).toBeGreaterThan(0)
    expect(JSON.stringify(requests[0].messages)).toContain('Operon fixture instructions')
    expect(JSON.stringify(requests[0].messages)).toContain('Inspect src/auth.ts \\"error handling\\".')
    const readback = await client.session.get({ sessionID: session.id! })
    expect(readback.agent).toBe('plan')
    expect(readback.model?.variant).toBe('high')
    expect(readback.model?.id).toBe('fixture-2')
    for await (const _part of session.send('Reply OK again.', { signal: AbortSignal.timeout(15_000) })) { /* drain */ }
    expect(requests.at(-1)?.model).toBe('fixture-2')
    const compacted: RuntimeStreamPart[] = []
    for await (const part of session.send('/compact')) compacted.push(part)
    expect(compacted.filter((part) => part.type === 'error')).toEqual([])
    expect(compacted).toContainEqual(expect.objectContaining({ type: 'finish', finishReason: 'stop' }))
    expect((await client.plugin.list({ location: { directory: root } })).data).toContainEqual(expect.objectContaining({ id: 'operon.caller-identity', state: { status: 'active' } }))
  } finally {
    if (session.id) await client.session.remove({ sessionID: session.id }).catch(() => {})
    await session.close()
    server.close()
    await Promise.all([close(mcp), close(llm)])
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
