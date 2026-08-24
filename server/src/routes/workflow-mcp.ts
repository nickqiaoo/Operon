/**
 * Workflow MCP Server (desktop) — the protocol layer, and nothing else.
 *
 * Exposes ONE tool, `OperonWorkflow`: a deterministic JS orchestration runtime over
 * sub-agents, using the SAME engine as the operon-agents framework's built-in
 * Workflow (sandbox / parallel / pipeline / worktree isolation), but whose
 * `agent()` dispatches to ANY of OUR providers (custom / codex / claude-code /
 * gemini / kimi / opencode / cursor / copilot).
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
import {
  IN_APP_AGENT,
  IN_APP_PROVIDER_ID,
  toProviderId,
  type WorkflowRunContext,
} from '../services/workflow/engine-hooks.js'
import { startRun } from '../services/workflow/run.js'
import { readRunScript } from '../services/workflow/store.js'
import { getChatStorage } from '../services/ai/state.js'
import { getProviderModels, getProviders } from '../services/ai/providers.js'
import { warmAllProviders } from '../services/ai/provider-models-cache.js'

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
 * How many models are listed outright.
 *
 * Above this the entry degrades to a summary instead. Sized from the real
 * spread: CLI agents report 1–17 models each (the whole install is ~2KB), so
 * they always list in full and nothing changes for them. The one that can be
 * enormous is `operon`, whose models are not a CLI's fixed set but every model
 * of every LLM provider the user has an API key for — an OpenRouter key alone is
 * several hundred.
 */
const INLINE_MODEL_LIMIT = 25
/** Vendor groups offered when a list is too long to show. */
const MAX_GROUPS = 20
/** Ids shown alongside the groups, purely to make the shape concrete. */
const SAMPLE_SIZE = 5

interface AgentModelCatalogEntry {
  agentType: string
  /** What this agent runs when a script passes `model: 'default'`. Never filtered out. */
  currentModel?: string
  /** The choosable list — present only when short enough to choose from directly. */
  models?: Array<{ id: string; name?: string }>
  /** Total matching this lookup. Present only when `models` was withheld. */
  totalModels?: number
  /** Vendor prefixes with counts — the menu to put in front of the user. */
  groups?: Array<{ prefix: string; count: number }>
  /** Set only when `groups` was cut: how many families there actually are. */
  totalGroups?: number
  sample?: string[]
  hint?: string
  /** The provider could not be reached even after waiting for its probe. */
  pending?: boolean
  error?: string
}

/**
 * Group ids by everything before the last `/`.
 *
 * Derived from the data rather than from a hand-kept vendor table: an operon id
 * is `<llm-provider>/<vendor>/<model>` (`openrouter/anthropic/claude-…`), so this
 * yields exactly the axis a person chooses along. Ids with no slash (`gpt-5.6-sol`)
 * have no meaningful group, and those lists are short anyway.
 */
function groupByPrefix(ids: readonly string[]): {
  groups: Array<{ prefix: string; count: number }>
  total: number
} {
  const counts = new Map<string, number>()
  for (const id of ids) {
    const cut = id.lastIndexOf('/')
    if (cut <= 0) continue
    const prefix = id.slice(0, cut)
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
  }
  const sorted = [...counts.entries()]
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix))
  // Biggest families first, so the cut only ever drops long-tail vendors — and
  // it says how many it dropped, because `query` still searches all of them.
  return { groups: sorted.slice(0, MAX_GROUPS), total: sorted.length }
}

function matches(model: { modelId: string; name?: string }, query: string): boolean {
  const needle = query.toLowerCase()
  return (
    model.modelId.toLowerCase().includes(needle) ||
    (model.name ?? '').toLowerCase().includes(needle)
  )
}

/**
 * One agent's entry, listed in full or summarised.
 *
 * Truncating to "the first N of 300" would be worse than either: the order is
 * arbitrary, so the model the user wants is probably not in the window, and a
 * short list reads as a complete one. A summary says plainly that there are more
 * and gives the caller something specific to ask about.
 */
function toEntry(
  agentType: string,
  result: Awaited<ReturnType<typeof getProviderModels>>,
  query?: string,
): AgentModelCatalogEntry {
  const currentModel = result.currentModelId || undefined
  const matching = query ? result.models.filter((model) => matches(model, query)) : result.models
  const base = {
    agentType,
    currentModel,
    ...(result.modelsPending ? { pending: true } : {}),
  }

  if (matching.length <= INLINE_MODEL_LIMIT) {
    return {
      ...base,
      models: matching.map((model) => ({ id: model.modelId, name: model.name })),
      ...(query && matching.length === 0
        ? { hint: `No model matches "${query}" for ${agentType}. Call again with a different query, or omit it.` }
        : {}),
    }
  }

  const { groups, total: totalGroups } = groupByPrefix(matching.map((model) => model.modelId))

  // Groups are only an answer if they actually split the list. One group (or
  // none) means every match shares a prefix — offering "openrouter/anthropic
  // (64), pick one" is a dead end, since the thing the user just narrowed by is
  // the only option. Show a window instead and say what it is a window onto.
  if (groups.length < 2) {
    return {
      ...base,
      models: matching.slice(0, INLINE_MODEL_LIMIT).map((model) => ({ id: model.modelId, name: model.name })),
      totalModels: matching.length,
      hint:
        `Showing ${INLINE_MODEL_LIMIT} of ${matching.length}${query ? ` matching "${query}"` : ''}. ` +
        'Narrow the query further, or let the user pick from these.',
    }
  }

  return {
    ...base,
    totalModels: matching.length,
    groups,
    ...(totalGroups > groups.length ? { totalGroups } : {}),
    // The first entries are the user's hand-entered model ids (`manualModels` is
    // pushed before anything fetched), which makes this sample the most likely
    // to be the ones they actually use.
    sample: matching.slice(0, SAMPLE_SIZE).map((model) => model.modelId),
    hint:
      `${matching.length} models — too many to choose from. Ask the user which family they want ` +
      `(offer the groups above${totalGroups > groups.length ? `, ${totalGroups} in total` : ''}), then call ` +
      `${LIST_MODELS_TOOL_NAME} again with query:"<their answer>" — it searches every model, not just the listed families. ` +
      `model:'default' uses ${currentModel ?? 'this agent’s own model'} without choosing.`,
  }
}

/**
 * Read each agent's model list from the provider cache.
 *
 * The cache is SWR: a warm read is instant, and a provider that is still probing
 * its CLI returns `modelsPending` with an EMPTY list rather than waiting. That is
 * right for a UI that re-renders, and wrong here — this catalog is read once, to
 * put in front of a user, and "copilot: no models" would read as "that agent has
 * nothing to offer" when it simply had not finished starting. So pending entries
 * are given one wait (`warmAllProviders` awaits the refresh) and re-read.
 *
 * One failing provider yields an entry with `error` rather than failing the whole
 * lookup: the user can still choose for the agents that did answer.
 */
async function agentModelCatalog(
  availableAgents: readonly string[],
  query?: string,
): Promise<AgentModelCatalogEntry[]> {
  const read = async (agentType: string): Promise<AgentModelCatalogEntry> => {
    try {
      return toEntry(agentType, await getProviderModels(toProviderId(agentType)), query)
    } catch (error) {
      return {
        agentType,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const first = await Promise.all(availableAgents.map(read))
  const stillProbing = first.filter((entry) => entry.pending).map((entry) => entry.agentType)
  if (stillProbing.length === 0) return first

  await warmAllProviders(stillProbing.map(toProviderId))
  const settled = new Map(await Promise.all(stillProbing.map(async (a) => [a, await read(a)] as const)))
  return first.map((entry) => settled.get(entry.agentType) ?? entry)
}

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

  const handle = (c: Context) => {
    const cwd = c.req.query('cwd') ?? process.cwd()
    const sessionId = Number(c.req.query('sessionId') ?? '')
    const chatId = Number.isFinite(sessionId) && sessionId > 0 ? sessionId : null
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
    return serveMcpOverHono(c, buildWorkflowMcpServer({ availableAgents, cwd, chatId, sessionModelId }))
  }

  router.post('/', handle)
  router.get('/', handle)
  router.delete('/', handle)

  return router
}
