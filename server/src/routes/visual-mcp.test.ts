import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildVisualMcpServer } from './visual-mcp.js'
import { setHtmlSnapshotter } from '../services/visual/html-snapshot.js'

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildVisualMcpServer().connect(serverSide)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(clientSide)
  return client
}

afterEach(() => setHtmlSnapshotter(null))

describe('visual MCP', () => {
  it('offers html_preview only where pages can be rendered', async () => {
    const headless = await connect()
    const bare = await headless.listTools()
    expect(bare.tools.map((t) => t.name)).toEqual(['html_render'])
    expect(bare.tools[0].description).not.toContain('html_preview')

    setHtmlSnapshotter(async () => ({ jpeg: Buffer.from('jpg'), contentHeight: 120, capturedHeight: 120, console: [] }))
    const desktop = await connect()
    const tools = (await desktop.listTools()).tools
    expect(tools.map((t) => t.name)).toEqual(['html_preview', 'html_render'])
    expect(tools[1].description).toContain('Check the page with html_preview first')
  })

  it('returns the screenshot as an image unless asked not to', async () => {
    setHtmlSnapshotter(async () => ({ jpeg: Buffer.from('jpg'), contentHeight: 120, capturedHeight: 120, console: [{ level: 'error', text: 'boom' }] }))
    const client = await connect()
    const withShot = await client.callTool({ name: 'html_preview', arguments: { html: '<p>x</p>' } })
    const content = withShot.content as Array<{ type: string; mimeType?: string; text?: string }>
    expect(content.map((c) => c.type)).toEqual(['image', 'text'])
    expect(content[0].mimeType).toBe('image/jpeg')
    expect(JSON.parse(content[1].text ?? '')).toMatchObject({ width: 720, contentHeight: 120, console: [{ level: 'error', text: 'boom' }] })

    const textOnly = await client.callTool({ name: 'html_preview', arguments: { html: '<p>x</p>', screenshot: false } })
    expect((textOnly.content as Array<{ type: string }>).map((c) => c.type)).toEqual(['text'])
  })
})
