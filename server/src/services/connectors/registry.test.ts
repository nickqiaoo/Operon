import { describe, expect, it } from 'vitest'
import { getConnectorDescriptor, resolvePluginApp } from './registry.js'

const app = (id: string) => ({ alias: 'test', id, required: true })

describe('connector registry', () => {
  it('turns no-auth, DCR, and CIMD Streamable HTTP entries into MCP configs', async () => {
    const noAuth = await resolvePluginApp(app('asdk_app_6944288d82108191a97261e0be991d3a'))
    const dcr = await resolvePluginApp(app('asdk_app_6934801c799081918131791660f02890'))
    const cimd = await resolvePluginApp(app('asdk_app_693a0a79ffe48191901173077edcf914'))

    expect(noAuth).toMatchObject({
      support: 'supported',
      requiresAuth: false,
      mcpServer: { transport: 'http', url: 'https://mcp.networksolutions.com/mcp' },
    })
    expect(dcr).toMatchObject({
      support: 'supported',
      requiresAuth: true,
      mcpServer: { transport: 'http', url: 'https://replit-mcp.com/server/mcp' },
    })
    expect(cimd).toMatchObject({
      support: 'supported',
      requiresAuth: true,
      mcpServer: { transport: 'http', url: 'https://api.lovable.dev/mcp/v2' },
    })
  })

  it('keeps vendor OAuth, OpenAI adapters, and legacy SSE out of the portable runtime', async () => {
    const vendorOAuth = await resolvePluginApp(app('asdk_app_691f1f8f72408191afdbbdf8242bdf86'))
    const adapter = await resolvePluginApp(app('connector_1e4f6a44acf14e3ca1d96672f8c945bc'))
    const sse = await resolvePluginApp(app('asdk_app_694427dd7b9c8191a6392847528c42d2'))

    expect(vendorOAuth.support).toBe('setup-required')
    expect(adapter.support).toBe('adapter-required')
    expect(sse).toMatchObject({
      support: 'unsupported',
      reason: 'Legacy SSE connectors are not supported in this phase.',
    })
    expect(vendorOAuth.mcpServer).toBeUndefined()
    expect(adapter.mcpServer).toBeUndefined()
    expect(sse.mcpServer).toBeUndefined()
  })

  it('serves normalized metadata by either app id or resolved connector id', async () => {
    const byApp = await getConnectorDescriptor('asdk_app_69a089a326dc8191b32a3f2553f5be2c')
    const byConnector = await getConnectorDescriptor(byApp!.connectorId!)

    expect(byApp).toMatchObject({
      name: 'Linear',
      support: 'adapter-required',
      transport: 'native-service',
      authMode: 'pre-registered-oauth',
    })
    expect(byConnector).toEqual(byApp)
  })
})
