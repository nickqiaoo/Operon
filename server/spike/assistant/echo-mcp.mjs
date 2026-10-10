// Minimal stdio MCP server for the assistant spike: one read-only tool, so we can
// check that MCP tools get the `intent` wrapper like built-in ones.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync } from 'node:fs'

const WEATHER = { beijing: 'Sunny, 22°C', suzhou: 'Light rain, 19°C', shanghai: 'Cloudy, 21°C' }

const server = new Server({ name: 'spike-weather', version: '0.0.1' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_weather',
      description: 'Current weather for a Chinese city (beijing, suzhou or shanghai).',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name in lowercase pinyin' } },
        required: ['city'],
        additionalProperties: false,
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {}
  // Record exactly what arrived, so the spike can prove `intent` was stripped.
  if (process.env.SPIKE_MCP_LOG) appendFileSync(process.env.SPIKE_MCP_LOG, `${JSON.stringify(args)}\n`)
  const city = String(args.city ?? '').toLowerCase()
  const text = WEATHER[city] ?? `No data for ${city}`
  return { content: [{ type: 'text', text: `${city}: ${text}` }] }
})

await server.connect(new StdioServerTransport())
