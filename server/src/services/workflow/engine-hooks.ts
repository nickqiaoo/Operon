/**
 * The desktop side of the imported workflow engine.
 *
 * `operon-agents` runs the script (sandbox, parallel, pipeline, journal); this
 * supplies the two things it cannot know: how to run ONE sub-agent on one of the
 * user's installed coding agents, and where progress goes. Both now do exactly
 * one thing — append events. No state is held here; nothing else reads anything
 * this writes except through the store.
 *
 * The framework repo is never modified: these are the documented host hooks.
 */

import os from 'node:os'
import {
  LocalMachine,
  createWorktree,
  newAgentId,
  validateValue,
  type WorkflowHostHooks,
  type WorkflowProgressEvent as FwProgressEvent,
} from 'operon-agents'
import { runProviderAgent } from './dispatch.js'
import type { RunEventWriter } from './writer.js'

/**
 * The in-app agent.
 *
 * Two names on purpose: `operon` is what the model writes (`custom` is an
 * internal provider id that means nothing to an author and reads like "the
 * default one"), `custom` is what the session manager is registered under. The
 * old name is still accepted as input so a model that memorised it does not
 * fail, but it is never advertised.
 */
export const IN_APP_AGENT = 'operon'
export const IN_APP_PROVIDER_ID = 'custom'

/** Public agentType → the provider id the session manager knows. */
export function toProviderId(agentType: string): string {
  return agentType === IN_APP_AGENT ? IN_APP_PROVIDER_ID : agentType
}

export interface WorkflowRunContext {
  availableAgents: string[]
  cwd: string
  /** The launching chat id — routes approvals and the result back. */
  chatId?: number | null
  /** Model a `custom` sub-agent runs on when the script names none. */
  sessionModelId?: string
}

/**
 * Resolve the provider a sub-agent runs on. Mandatory, and never guessed —
 * including the "close enough" guess of falling back to the in-app agent when
 * the name is unknown. A typo'd `claude` silently running somewhere else is
 * worse than a failed agent that says which names exist.
 */
export function requireAgentType(agentType: string | undefined, available: readonly string[]): string {
  const requested = typeof agentType === 'string' ? agentType.trim() : ''
  const choices = available.join(', ')
  if (!requested) {
    throw new Error(
      `agent() requires an explicit agentType — one of: ${choices}. ` +
        'There is no default: ask the user which agent should do this work.',
    )
  }
  if (requested === IN_APP_PROVIDER_ID) return IN_APP_PROVIDER_ID
  if (!available.includes(requested)) {
    throw new Error(`unknown agentType "${requested}" — available on this machine: ${choices}`)
  }
  return toProviderId(requested)
}

/**
 * A sub-agent that produced no text is a FAILED sub-agent, not an empty success.
 *
 * A turn can end silently — an unconfigured model, a provider that swallowed its
 * own error — and returning "" would flow that emptiness into the workflow's
 * result (two agents answering "ping"/"pong" produced " / "). Failing here marks
 * the agent red and says what to check, instead of a run that looks like it worked.
 */
function requireOutput(text: string, providerId: string, modelId: string | undefined): string {
  if (text.trim()) return text
  throw new Error(
    `sub-agent produced no output (provider "${providerId}"${modelId ? `, model "${modelId}"` : ''}) — ` +
      'check that this provider is configured and its model is reachable',
  )
}

/**
 * The model a sub-agent runs on.
 *
 * `'default'` is the escape hatch the tool documents: the user was asked and said
 * "whatever that agent already uses". It has to reach the provider as `undefined`,
 * not as a literal model id — each provider substitutes its own default for
 * undefined (`params.modelId ?? …`), and a provider handed the string "default"
 * would try to run a model by that name. (Claude's real default IS `default`, so
 * for it the two paths converge, which is exactly why the sentinel reads well.)
 *
 * The in-app agent keeps its own fallback: it has no CLI of its own to remember a
 * model, so an unnamed model would land on a provider constant whose API key the
 * user may never have configured. It inherits the launching conversation's instead.
 */
export const PROVIDER_DEFAULT_MODEL = 'default'

function resolveModel(
  model: string | undefined,
  providerId: string,
  ctx: WorkflowRunContext,
): string | undefined {
  const named = model === PROVIDER_DEFAULT_MODEL ? undefined : model
  if (named) return named
  return providerId === IN_APP_PROVIDER_ID ? ctx.sessionModelId : undefined
}

function jsonInstruction(schema: unknown): string {
  return (
    `Respond with ONLY a single JSON object matching this JSON Schema. ` +
    `No prose, no explanation, no markdown fences:\n${JSON.stringify(schema)}`
  )
}

function tryParseJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    return undefined
  }
}

export function buildHooks(
  ctx: WorkflowRunContext,
  writer: RunEventWriter,
  controller: AbortController,
): WorkflowHostHooks {
  const emitProgress = (ev: FwProgressEvent): void => {
    if (ev.type === 'phase') {
      writer.emit({ kind: 'phase', index: ev.index, title: ev.title, phaseKind: ev.kind })
    } else if (ev.type === 'agent') {
      // Only the fields the engine actually knows. Patch semantics keep this from
      // blanking the host-side facts (agentType, model, timings) that `runAgent`
      // records for the same index — the engine has no notion of those, and the
      // whole point of this workflow is showing WHICH agent ran each step.
      writer.emit({
        kind: 'agent',
        index: ev.record.index,
        patch: {
          label: ev.record.label,
          phase: ev.record.phase,
          state: ev.record.state,
          resultPreview: ev.record.resultPreview,
          error: ev.record.error,
        },
      })
    } else if (ev.type === 'log') {
      writer.emit({ kind: 'log', message: ev.message })
    }
    // `started` / `outcome` are dropped on purpose: this run's own `started` and
    // `settled` events are written by `run.ts`, which knows facts the engine does
    // not (chat id, script, resume flag, final result). Mirroring the engine's
    // versions would append a second, poorer copy of both to the same log.
  }

  const runAgent: WorkflowHostHooks['runAgent'] = async ({
    index,
    prompt,
    agentType,
    model,
    schema,
    isolation,
    signal,
    onStart,
  }) => {
    const providerId = requireAgentType(agentType, ctx.availableAgents)
    const modelId = resolveModel(model, providerId, ctx)
    const agentId = newAgentId(providerId)
    // The framework joins orchestration records to a child's own event stream by
    // address. A sub-agent here runs on an EXTERNAL provider and has no framework
    // session of its own, so its id is the whole address — flat, but unique.
    const identity = { agentId, address: agentId }
    onStart?.(identity)
    // The engine emits `running` before it calls us, so it cannot know any of
    // this; record it as soon as the dispatch decision is made.
    writer.emit({ kind: 'agent', index, patch: { agentType: providerId, modelId, startedAt: Date.now() } })

    // Optional git-worktree isolation for file-mutating parallel agents — the
    // framework's own createWorktree. Degrades WITH A LOG when the cwd is not a
    // git repo (never silently); changes are NOT auto-merged back.
    let runCwd = ctx.cwd
    let cleanupWorktree: (() => Promise<void>) | undefined
    if (isolation === 'worktree') {
      const worktree = await createWorktree(new LocalMachine(ctx.cwd), { label: agentId })
      if (worktree) {
        runCwd = worktree.cwd
        cleanupWorktree = worktree.cleanup
        writer.emit({ kind: 'log', message: `🌳 ${agentId}: isolated worktree at ${worktree.cwd}` })
      } else {
        writer.emit({
          kind: 'log',
          message: `isolation:'worktree' unavailable (cwd is not a git repo) — running in the shared workspace`,
        })
      }
    }

    const runOne = (p: string): Promise<string> =>
      runProviderAgent({
        providerId,
        modelId,
        cwd: runCwd,
        prompt: p,
        agentId,
        // A blocked sub-agent shows up on this run's card (where the user is
        // watching) AND in the launching conversation's inbox as a fallback.
        parentChatId: ctx.chatId,
        onApproval: (request) => writer.emit({ kind: 'approval', approval: request }),
        onApprovalSettled: (approvalId) => writer.emit({ kind: 'approval-resolved', approvalId }),
        // The sub-agent's own output. Buffered by the writer and appended to the
        // log — which is both how a watcher sees it live and how it is still
        // there tomorrow. There is no separate "recording" path any more.
        onChunk: (chunk) => writer.chunk(index, chunk),
        signal,
      })

    try {
      if (!schema) {
        const text = await runOne(prompt)
        return { value: requireOutput(text, providerId, modelId), outputTokens: 0, ...identity }
      }
      // Structured output: external providers cannot take the framework's
      // StructuredOutput tool, so it is enforced here — instruct, parse, validate, retry.
      let attemptPrompt = `${prompt}\n\n${jsonInstruction(schema)}`
      let lastError = ''
      for (let attempt = 1; attempt <= 3; attempt++) {
        const text = await runOne(attemptPrompt)
        const parsed = tryParseJson(text)
        const verdict = validateValue(schema, parsed)
        if (verdict.ok) return { value: parsed, outputTokens: 0, ...identity }
        lastError = verdict.error
        attemptPrompt =
          `${prompt}\n\n${jsonInstruction(schema)}\n\n` +
          `Your previous reply was invalid: ${lastError}. Return ONLY the corrected JSON object.`
      }
      throw new Error(`sub-agent produced no schema-valid output after 3 attempts: ${lastError}`)
    } finally {
      writer.emit({ kind: 'agent', index, patch: { endedAt: Date.now() } })
      if (cleanupWorktree) await cleanupWorktree()
    }
  }

  return {
    runAgent,
    emitProgress,
    concurrency: Math.min(16, Math.max(2, os.cpus().length - 2)),
    // Token budgets are NOT metered — sub-agents run on the external providers'
    // own accounts. `total: null` keeps the framework's `budget.total && …`
    // guards inert; the 1000-agent hard cap remains the runaway backstop.
    budget: { total: null, getTurnSpent: () => 0 },
    abortSignal: controller.signal,
  }
}
