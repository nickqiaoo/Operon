/**
 * Workflow MCP Server (desktop) — the protocol layer, and nothing else.
 *
 * Exposes ONE tool, `OperonWorkflow`: a deterministic JS orchestration runtime over
 * sub-agents, using the SAME engine as the operon-agents framework's built-in
 * Workflow (sandbox / parallel / pipeline / worktree isolation), but whose
 * `agent()` dispatches to ANY of OUR providers (custom / codex / claude-code /
 * kimi / opencode / cursor / copilot).
 *
 * Delivered over MCP, so every provider that speaks MCP gets the tool (injected
 * per-session in `mcp-config.ts`). Mounted at /api/workflow-mcp, with the
 * per-session context on the URL: `?sessionId=<chatId>&cwd=<workspace>`. The
 * available agents are NOT on the URL — they are the same for every caller and
 * are read live per request, so installing a CLI takes effect immediately.
 *
 * This file decides only WHETHER a run may start — is the script valid, does
 * every agent() name an agentType, did the user actually choose the agents — and
 * hands off to `services/workflow/run.ts`. It holds no run state, writes no
 * storage, and knows nothing about how a run is observed. See
 * the workflow MCP design.
 */

import { Hono, type Context } from 'hono'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { parseWorkflow, newAgentId } from 'operon-agents'
import { serveMcpOverHono, withCodexElicitationFallback } from './mcp-http.js'
import { resolveMcpCallerChat } from './mcp-caller.js'
import {
  IN_APP_AGENT,
  IN_APP_PROVIDER_ID,
  type WorkflowRunContext,
} from '../services/workflow/engine-hooks.js'
import { startRun } from '../services/workflow/run.js'
import { readRunScript } from '../services/workflow/store.js'
import { getChatStorage } from '../services/ai/state.js'
import { getProviders } from '../services/ai/providers.js'
import { agentModelCatalog } from '../services/agents/model-catalog.js'

/**
 * Named for the product, not for what it does.
 *
 * It was `RunWorkflow`, which sat one synonym away from the `Workflow` tool
 * several host agents ship built in — and a model holding both reached for
 * whichever it saw first, then reported a run that never appears in our panel.
 * The name now says whose tool it is, which is the one thing the caller has to
 * get right. (Cards from before the rename still render as ours; see
 * `workflowToolName.ts`.)
 */
export const WORKFLOW_MCP_TOOL_NAME = 'OperonWorkflow'

/**
 * Companion lookup tool: which models each agent can run.
 *
 * A separate tool rather than more text in the main description, because the
 * catalog is installation-specific, changes without us, and is far too long for
 * a description that has to stay inside Grok's discovery limit. It is also only
 * needed once per workflow — at the point the caller is about to ask the user.
 */
export const LIST_MODELS_TOOL_NAME = 'ListAgentModels'

/**
 * The `custom` model a sub-agent should default to: the launching conversation's,
 * or — when the workflow was launched from some other provider, whose model id
 * means nothing to `custom` — the one the user last ran `custom` on. Undefined
 * only when they never have, leaving the provider to pick a configured default.
 */
function defaultCustomModel(chatId: number | null): string | undefined {
  const storage = getChatStorage()
  if (!storage) return undefined
  if (chatId != null) {
    const meta = storage.getChatMeta(chatId)
    if (meta?.providerId === 'custom' && meta.model) return meta.model
  }
  // Newest first; scan a bounded window rather than the whole history.
  for (const entry of storage.listChatEntries({ limit: 200 })) {
    if (entry.providerId === 'custom' && entry.model) return entry.model
  }
  return undefined
}

/** Keep the complete authoring guide in `/operon-workflow`; this is the discovery-safe contract. */
export function workflowToolDescription(availableAgents: readonly string[]): string {
  const agentTypes = availableAgents.join(', ')
  return [
    'Run a deterministic JavaScript workflow that orchestrates multiple sub-agents.',
    'See /operon-workflow for the full authoring guide.',
    '',
    'Pass a self-contained inline `script` beginning with:',
    "export const meta = { name: '...', description: '...', phases: [{ title: '...' }] }",
    '',
    'Core APIs:',
    '- agent(prompt: string, options?) returns final text, or parsed JSON with options.schema. The first argument must be a string; never call agent({ prompt: ... }).',
    '- parallel([() => agent(...), ...]) runs independent thunks concurrently — pass functions, not promises.',
    '- pipeline(items, ...stages) runs dependent per-item stages.',
    "- phase(title) declares a progress group; an agent joins it only by passing the SAME title as its `phase` option — phase() alone groups nothing.",
    '- log(message) logs; args holds the tool input.',
    '',
    `agent options: agentType (REQUIRED), model (REQUIRED), label, phase, schema, isolation:'worktree'.`,
    `Every agent() MUST name an agentType, from: ${agentTypes}. There is no default — an agent() without one fails.`,
    `It MUST also name a model: an id from ${LIST_MODELS_TOOL_NAME}, or 'default' to accept that agent's own.`,
    'Each agent() can run on a DIFFERENT installed coding agent — its own model, account and strengths.',
    `${IN_APP_AGENT} is the app's own in-built agent: use it ONLY when the user explicitly asks for it.`,
    `YOU MUST ASK THE USER which agent and which model each step runs on — call ${LIST_MODELS_TOOL_NAME}, show the choices, let them decide, never pick silently. Then call with agents_chosen_by_user: true; the tool refuses to start without it.`,
    'There may be TWO workflow tools here: this one (OperonWorkflow) and your own built-in one. They differ. Ask the user which one to use.',
    'Scripts are JavaScript, not TypeScript, and must return a JSON-serializable value or string.',
    'Runs are ALWAYS in the background: a runId comes back at once, progress shows in the Workflows panel, and the result returns here on its own. Do not poll. Resume with resumeFromRunId.',
    // Keep the whole description under 2000 chars — Grok drops tools whose
    // description exceeds its discovery limit, so a line added here has to be
    // paid for by a line removed. The contract test asserts the budget.
  ].join('\n')
}

function buildWorkflowMcpServer(ctx: WorkflowRunContext): Server {
  const server = new Server({ name: 'workflow', version: '1.0.0' }, { capabilities: { tools: {} } })

  const tools: Tool[] = [
    {
      name: WORKFLOW_MCP_TOOL_NAME,
      description: workflowToolDescription(ctx.availableAgents),
      inputSchema: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description:
              'Self-contained JavaScript workflow. Begin with a pure-literal `export const meta = { name, description, phases: [{ title }] }`. Call agents as `agent("prompt", { agentType: "..." })` — the first argument must be a string and agentType is REQUIRED on every call (see the tool description for the ids available here; ask the user when unsure). Pass functions to parallel: `parallel([() => agent(...), ...])`. Omit script only when resuming via `resumeFromRunId`.',
          },
          agents_chosen_by_user: {
            type: 'boolean',
            description:
              'Required (true) to start a new run. Set it ONLY after the user has actually told you which agents to run this workflow on — ask them, listing the agentType values available here. Choosing for them spends their accounts and quota on agents they may not have wanted.',
          },
          args: {
            type: 'object',
            description: 'Optional value exposed to the script as the global `args` (pass real JSON).',
          },
          resumeFromRunId: {
            type: 'string',
            description:
              'Resume a prior run: re-runs under this runId so the journal replays — already-finished sub-agents are skipped and only the interrupted tail re-runs. Omit `script` to reuse the run\'s persisted script.',
          },
        },
        // No hard `required`: provide `script` OR `resumeFromRunId` (validated in the handler).
      },
    },
    {
      name: LIST_MODELS_TOOL_NAME,
      description: [
        'List the models each Operon agent can run, so you can ask the user which to use.',
        "Call this BEFORE OperonWorkflow: every agent() must name a model, and the choice is the user's.",
        'Returns per agent: its current model, and either the full list of ids you may pass as `model`,',
        'or — when an agent has too many to choose from — `groups` (families with counts) and a `hint`.',
        'In that case ask the user which family they want, then call again with `query` set to their answer.',
        "Pass model:'default' for an agent to accept whatever that agent is already configured to use.",
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          agentTypes: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Restrict the lookup to these agents. Omit for every agent available here.',
          },
          query: {
            type: 'string',
            description:
              'Case-insensitive substring filter over model ids and names — pass what the user asked for ("anthropic", "sonnet", "gpt-5"). Use it to narrow an agent that came back with `groups` instead of a list.',
          },
        },
      },
    },
  ]

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

    if (req.params.name === LIST_MODELS_TOOL_NAME) {
      const requested = Array.isArray(args.agentTypes)
        ? args.agentTypes.filter((id): id is string => typeof id === 'string')
        : []
      const wanted = requested.length > 0
        ? requested.filter((id) => ctx.availableAgents.includes(id))
        : ctx.availableAgents
      const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : undefined
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ...(query ? { query } : {}),
              agents: await agentModelCatalog(wanted, query),
              note:
                'Ask the user which agent and model each step should use, then pass both on every agent(). ' +
                "model:'default' means that agent's own configured model. " +
                'An agent that returned `groups` instead of `models` has too many to list — ask which family, then call again with `query`.',
            }),
          },
        ],
      }
    }

    if (req.params.name !== WORKFLOW_MCP_TOOL_NAME) {
      return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true }
    }

    // Resume (model-driven, CC-style): re-invoke with a prior runId to continue an
    // interrupted run. Same runId + same script replays that run's journal events —
    // finished agent() calls return cached, only the interrupted tail re-runs. The
    // script comes from the run's `started` event when the model omits it. (There is
    // no UI resume button by design: a workflow belongs to its conversation.)
    const resumeFromRunId =
      typeof args.resumeFromRunId === 'string' && args.resumeFromRunId.trim() ? args.resumeFromRunId.trim() : undefined
    let script = typeof args.script === 'string' ? args.script : ''
    let runArgs = args.args
    if (resumeFromRunId && !script.trim()) {
      const stored = readRunScript(resumeFromRunId)
      if (!stored) return err(`Cannot resume "${resumeFromRunId}": no persisted script for that run.`)
      script = stored.script
      if (runArgs === undefined) runArgs = stored.args
    }
    if (!script.trim()) return err('Provide `script` (inline workflow), or `resumeFromRunId` of a persisted run.')

    const parsed = parseWorkflow(script)
    if ('error' in parsed) return err(`Invalid workflow script: ${parsed.error}`)
    const { meta, scriptBody } = parsed

    // Consent FIRST, before either script check.
    //
    // It is the root instruction the other two are consequences of, it is the
    // cheapest test here (a boolean, versus a catalog read that may probe CLIs),
    // and answering it produces the agentType and model the script was missing
    // anyway. Reporting "name a model" to a caller who never asked the user would
    // just invite it to invent one.
    //
    // Which agents and models run the work is the user's call, not the model's:
    // it decides whose account and quota get spent, and on what. A prompt asking
    // for that is only a suggestion, so starting requires the caller to state the
    // user actually chose. Resume is exempt — that run was already chosen once.
    if (!resumeFromRunId && args.agents_chosen_by_user !== true) {
      return err(
        [
          'Ask the user which agent(s) should run this workflow before starting it — do not choose for them.',
          `Available agentType values here: ${ctx.availableAgents.join(', ')}.`,
          `Prefer the real coding agents; use ${IN_APP_AGENT} (the app's own agent) only if the user asks for it.`,
          `Ask which MODEL each step should use too — call ${LIST_MODELS_TOOL_NAME} for the choices.`,
          'Show them the options, say which you would use for which step and why, and let them decide.',
          'Then call again with agents_chosen_by_user: true.',
        ].join(' '),
      )
    }

    // Catch a missing agentType HERE, not one-agent-at-a-time inside the run: a
    // background run would otherwise hand back a runId and only then fail every
    // agent, leaving the caller thinking it launched something. Deliberately blunt
    // (does the script mention agentType at all?) so a value built dynamically or
    // passed through a shared options object still reaches the real check in
    // `requireAgentType`.
    const callsAgents = /\bagent\s*\(/.test(scriptBody)
    if (callsAgents && !/\bagentType\b/.test(scriptBody)) {
      return err(
        `Every agent() must name an agentType — one of: ${ctx.availableAgents.join(', ')}. ` +
          'There is no default. If the user has not said which agent should do this work, ask them first.',
      )
    }

    // Same gate, same reason, for the model. Which model runs a step decides both
    // the quality and the cost of it, and left unsaid every sub-agent silently
    // landed on whatever constant its provider hardcodes — not on anything the
    // user chose. The catalog rides along on the rejection so the caller can ask
    // the user immediately instead of making another round trip.
    if (callsAgents && !/\bmodel\b/.test(scriptBody)) {
      return err(
        [
          'Every agent() must also name a model. There is no default.',
          "Ask the user which model each step should run on — then pass `model: '<id>'`,",
          "or `model: 'default'` for an agent whose own configured model they are happy with.",
          `Models available here: ${JSON.stringify(await agentModelCatalog(ctx.availableAgents))}`,
        ].join(' '),
      )
    }

    const runId = resumeFromRunId ?? newAgentId('wf')
    startRun({
      ctx,
      runId,
      meta,
      script,
      scriptBody,
      args: runArgs,
      resumed: resumeFromRunId != null,
    })

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'async_launched',
            runId,
            task_id: runId,
            name: meta.name,
            summary: meta.description,
            ...(meta.phases ? { phases: meta.phases.map((ph) => ph.title) } : {}),
            message:
              'Workflow launched in the background. Watch live progress + the final result in the Workflows panel. ' +
              'Briefly tell the user what you launched, then continue or wait.',
          }),
        },
      ],
    }
  })

  return withCodexElicitationFallback(server)
}

export function workflowMcpRoutes() {
  const router = new Hono()

  const handle = async (c: Context) => {
    const cwd = c.req.query('cwd') ?? process.cwd()
    const caller = await resolveMcpCallerChat(c, 'sessionId')
    if (!caller.ok) return caller.response
    const chatId = caller.chatId
    // Read live, NOT passed in on the URL by the caller.
    //
    // `mcp-config` computes a session's MCP entries once, when the session is
    // created, and bakes them into this URL — so a baked-in agent list froze at
    // whatever was installed back then, and a CLI installed mid-session stayed
    // invisible to every conversation already open. Same-process, so there is
    // nothing to pass: ask for the list per request.
    //
    // Every installed provider is offered, INCLUDING the one calling this tool.
    // A workflow sub-agent is a fresh standalone session, not a handoff to
    // someone else, and fanning out to five agents on the provider you are
    // already running on is the common case (the caller used to be filtered out
    // here, which left e.g. a Claude conversation unable to dispatch to Claude).
    //
    // Public names, in the order they are offered: real coding agents first, the
    // in-app one LAST — a list is a recommendation, and the first entry is what a
    // model reaches for when it has not been told otherwise.
    const availableAgents = getProviders()
      .filter((p) => p.available)
      .map((p) => p.id)
      .filter((id) => id !== IN_APP_PROVIDER_ID && id !== IN_APP_AGENT)
    availableAgents.push(IN_APP_AGENT)
    const sessionModelId = defaultCustomModel(chatId)
    return serveMcpOverHono(c, buildWorkflowMcpServer({ availableAgents, cwd, chatId, sessionModelId }), caller.body)
  }

  router.post('/', handle)
  router.get('/', handle)
  router.delete('/', handle)

  return router
}
