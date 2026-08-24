/**
 * External Agent MCP Server.
 *
 * Exposes one tool:
 *   - external_agent_run  : Launch an external agent to work on a task
 *
 * Mounted at /api/external-agent-mcp in app.ts. The URL carries only ?caller=<id>;
 * the available-agent list is derived per request so a CLI appearing or timing out
 * does not rewrite the URL (which would change the session-reuse fingerprint).
 * Transport is the official MCP SDK Streamable HTTP (see ./mcp-http.ts) so strict
 * clients (Codex's rmcp) can handshake.
 */

import { Hono, type Context } from 'hono'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { getProviderModels, getSessionManager } from '../services/ai.js'
import { isAdapterAvailable } from '../services/adapter/bundled-cli-paths.js'
import { serveMcpOverHono, withCodexElicitationFallback } from './mcp-http.js'
import { subagentMode } from '../services/agents/subagent-mode.js'

// ---- Tool definitions ----

const SUPPORTED_EXTERNAL_AGENT_IDS = ['codex', 'claude-code', 'opencode', 'gemini', 'kimi', 'cursor', 'copilot'] as const

const EXTERNAL_AGENT_RUN_PROMPT =
  'Delegate a task to an external coding agent (e.g. Claude Code, Codex, OpenCode, Gemini, Cursor, GitHub Copilot). ' +
  'When the user explicitly mentions an agent by name (e.g. "use Claude Code to ...", "let Codex handle ...", ' +
  '"ask Gemini to ..."), you MUST call this tool IMMEDIATELY as your FIRST action — do NOT read files, ' +
  'run commands, or gather context beforehand. The external agent has its own tools and will handle everything itself. ' +
  'Write a self-contained prompt because the agent runs in a separate session and cannot see this conversation. ' +
  'IMPORTANT: After calling this tool, check whether later steps depend on the agent result. ' +
  'If the user specified a sequence (e.g. "first plan, then execute", "do X then Y"), ' +
  'you MUST STOP and WAIT for the agent result before proceeding to the next step. ' +
  'Only continue working on independent tasks that do not depend on the agent output.'

// Curated model hints per agent, shown in the tool's `model` arg description.
// This is display-only guidance — the arg is free-form and CallTool never
// validates against it, so any valid id still works (see the note in
// buildModelDescription). Agents whose live catalog is small and universal get a
// hand-picked list here; cursor's real list is ~150 effort/fast permutations, so
// only its headline models are surfaced. Agents NOT listed (opencode) fetch
// their catalog dynamically because it is account/BYOK-specific and can't be
// hardcoded product-wide.
const STATIC_AGENT_MODELS: Record<string, string[]> = {
  'claude-code': ['default', 'best', 'fable', 'opus', 'sonnet', 'haiku', 'sonnet[1m]', 'opus[1m]', 'opusplan'],
  'codex': ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
  'gemini': ['gemini-3.1-pro-preview', 'gemini-3-flash-preview'],
  kimi: ['kimi-code'],
  // Representative subset of cursor-agent's ~150 models (base variants, no
  // -fast/-thinking/-<effort> permutations). Full list stays available via the
  // in-app picker; this is only the external-agent hint.
  cursor: [
    'auto',
    'composer-2.5',
    'gpt-5.5-high',
    'gpt-5.3-codex',
    'claude-opus-4-8-high',
    'claude-sonnet-5-high',
    'gemini-3.1-pro',
    'grok-4.5-high',
  ],
  copilot: ['auto', 'gpt-5.4', 'gpt-5-mini', 'gpt-4.1', 'claude-haiku-4.5'],
}

async function fetchDynamicAgentModels(agentId: string): Promise<string[]> {
  try {
    const modelsResult = await getProviderModels(agentId)
    return modelsResult.configOptions
      ?.find((o) => o.category === 'model')
      ?.options?.map((o) => o.value) ?? []
  } catch {
    return [] // skip if the provider is unavailable / fails to enumerate models
  }
}

async function getAgentModelsMap(availableAgents: string[]): Promise<Record<string, string[]>> {
  const entries = await Promise.all(
    availableAgents.map(async (agentId): Promise<[string, string[]]> => {
      const models = STATIC_AGENT_MODELS[agentId] ?? (await fetchDynamicAgentModels(agentId))
      return [agentId, models]
    }),
  )
  return Object.fromEntries(entries.filter(([, models]) => models.length > 0))
}

// Cap how many model ids are listed per agent in the tool description. Dynamic
// providers (copilot, cursor, opencode) can enumerate dozens-to-hundreds of
// models; dumping them all bloats the tool schema and adds no signal. The `model`
// arg is a free-form string (CallTool never validates it against this list), so
// truncating the hint is safe — any unlisted valid id still works.
const MAX_MODELS_LISTED_PER_AGENT = 12

function buildModelDescription(agentModels: Record<string, string[]>): string {
  const lines = Object.entries(agentModels)
    .map(([agent, models]) => {
      const shown = models.slice(0, MAX_MODELS_LISTED_PER_AGENT)
      const more = models.length - shown.length
      return `${agent}: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`
    })
    .join('; ')
  return lines
    ? `Optional model ID override. Common models per agent — ${lines}. ` +
      'Any valid model id for the chosen agent is accepted even if not listed here. ' +
      'If omitted, the agent uses its default model.'
    : 'Optional model ID override for the external agent'
}

function buildTools(availableAgents: string[], agentModels: Record<string, string[]>) {
  if (availableAgents.length === 0) return []

  return [
    {
      name: 'external_agent_run',
      description: EXTERNAL_AGENT_RUN_PROMPT,
      inputSchema: {
        type: 'object',
        properties: {
          agent_type: {
            type: 'string',
            enum: availableAgents,
            description: `Which external agent to run. MUST be one of the enum values exactly: ${availableAgents.join(', ')}. Use hyphens, not underscores (e.g. "claude-code", NOT "claude_code").`,
          },
          prompt: {
            type: 'string',
            description:
              'Instructions for the external agent. Include the goal, constraints, and required context.',
          },
          description: {
            type: 'string',
            description: 'A short summary for display purposes',
          },
          model: {
            type: 'string',
            description: buildModelDescription(agentModels),
          },
        },
        required: ['agent_type', 'prompt', 'description'],
      },
    },
  ]
}

// ---- MCP server (official SDK) ----

function buildExternalAgentMcpServer(availableAgents: string[]): Server {
  const server = new Server(
    { name: 'external_agent', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const agentModels = await getAgentModelsMap(availableAgents)
    return { tools: buildTools(availableAgents, agentModels) as Tool[] }
  })

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params
    if (name !== 'external_agent_run') {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }

    const args = (rawArgs ?? {}) as Record<string, unknown>
    const agentType = String(args.agent_type ?? '')
    const prompt = String(args.prompt ?? '')
    const description = String(args.description ?? '')
    const model = args.model ? String(args.model) : undefined

    if (!availableAgents.includes(agentType)) {
      return {
        content: [
          {
            type: 'text',
            text: `Invalid agent_type: ${agentType}. Supported agents: ${availableAgents.join(', ')}`,
          },
        ],
      }
    }

    const taskId = `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            task_id: taskId,
            agent_type: agentType,
            prompt,
            description,
            model,
            // The spawned tab is a sub-agent: nobody is watching it, so it runs in
            // the provider's non-interactive mode instead of whatever the picker
            // last left selected. Resolved here because the table lives server-side
            // (services/agents/subagent-mode.ts) — the frontend just forwards it.
            mode: subagentMode(agentType),
            status: 'pending',
            message:
              'External agent task created. The task will run in a separate session. When the agent finishes, its result will be delivered to you as a new user message. ' +
              'CRITICAL: If subsequent steps depend on this result, you MUST end your current response immediately with a short status message — do NOT call any more tools, do NOT use sleep or polling. ' +
              'The notification can only arrive as a new user message after your current turn ends. Simply stop responding and wait.',
          }),
        },
      ],
    }
  })

  return withCodexElicitationFallback(server)
}

// ---- Hono router ----

export function externalAgentMcpRoutes() {
  const router = new Hono()

  const handle = (c: Context) => {
    // Derived per request, not read off the URL: availability comes from a live
    // probe, so freezing it into the URL at session-creation time made the
    // session-reuse fingerprint flap whenever a CLI came or went.
    const caller = c.req.query('caller') ?? ''
    const availableAgents = getSessionManager()
      .listProviders()
      .map((p: { id: string }) => p.id)
      .filter(
        (id: string) =>
          id !== caller &&
          isAdapterAvailable(id) &&
          SUPPORTED_EXTERNAL_AGENT_IDS.includes(id as (typeof SUPPORTED_EXTERNAL_AGENT_IDS)[number]),
      )
    return serveMcpOverHono(c, buildExternalAgentMcpServer(availableAgents))
  }

  router.post('/', handle)
  router.get('/', handle)
  router.delete('/', handle)

  return router
}
