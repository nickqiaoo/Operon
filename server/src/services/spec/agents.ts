/**
 * Running one spec role on one provider — and making it show up as a sub-agent
 * of the spec's workflow run.
 *
 * Every role in the design stage is read-only: it explores, sketches or judges,
 * and hands its result back as its final reply. The server writes the files.
 * So each agent runs in a throwaway git worktree cut from the change branch
 * (the framework's `createWorktree`, the same one Workflow's `isolation:
 * 'worktree'` uses): whatever it scribbles on disk is discarded with the
 * worktree, and nothing it does can land on the change branch.
 *
 * Each agent runs as a chat of its own (see `runProviderAgent`), named on its
 * row in the spec's workflow run; progress goes through that run's event log, so
 * it appears in the workflow tab and the spec's panel, and a sub-agent that asks
 * for permission surfaces on the run card, in its chat and in the chat's inbox.
 */

import { LocalEnvironment, createWorktree, newAgentId, validateValue } from 'operon-agents'
import { runProviderAgent } from '../workflow/dispatch.js'
import { parseJsonReply, splitTrailingJson, summarizeStructured } from '../workflow/json-reply.js'
import { excludeLocally } from '../git.js'
import type { RunEventWriter } from '../workflow/writer.js'
import type { SpecSeat } from '../../types/spec.js'

/** Tools that only read, across providers' naming. A spec role may use these without asking. */
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'list', 'ls', 'view', 'find'])

/** Appended to every role prompt: where the code is, so nobody wanders into the user's own checkout. */
const WORKSPACE_NOTE =
  'Your current working directory is a checkout of this repository. Read files by paths relative to it. ' +
  'If the material above names an absolute path into the repository, read the same relative path here instead.'

export interface SpecAgentContext {
  writer: RunEventWriter
  /** The change branch's worktree; disposable copies are cut from its HEAD. */
  cwd: string
  /** The chat that started the spec — approvals fall back to its inbox. */
  chatId: number | null
  /** The spec's change worktree's workspace — where its agents' chats belong. */
  workspaceId: number | null
  signal: AbortSignal
  /** First agent index to use: a continued run already has agents below it. */
  firstIndex?: number
  /**
   * Someone handed a running role to another provider. `seat` is the very object
   * the call was made with (a seat of the spec's config), so the spec can keep
   * the new provider for that role from now on.
   */
  onSeatReplaced?: (seat: SpecSeat, to: SpecSeat) => void
  /** The model a role handed to `providerId` runs on, when none was named. */
  modelFor?: (providerId: string) => string | undefined
}

export interface SpecAgentCall {
  /** What the run panel calls this agent, e.g. 'candidate A · codex'. */
  label: string
  /** The phase title it belongs to (must match an emitted `phase` event). */
  phase: string
  seat: SpecSeat
  prompt: string
  /** Checkout the disposable copy is cut from, when not the change worktree (a ticket review reads the ticket's branch). */
  cwd?: string
}

/** Cap on the preview kept on the agent row; the full output is in its chunks. */
const PREVIEW_CHARS = 280

/**
 * The row's one line. A structured reply (most roles answer in JSON) is
 * summarised as its fields — the first 280 characters of the raw object were
 * mostly braces and quotes, cut off before anything that mattered.
 */
function previewOf(reply: string): string {
  const structured = splitTrailingJson(reply)
  return structured ? summarizeStructured(structured.value) : reply.slice(0, PREVIEW_CHARS)
}

export class SpecAgents {
  private nextIndex: number

  constructor(private readonly ctx: SpecAgentContext) {
    this.nextIndex = ctx.firstIndex ?? 0
  }

  /** Run one agent to completion and return its final reply. Throws on empty output. */
  async text(call: SpecAgentCall): Promise<string> {
    return this.run(call, (reply) => reply)
  }

  /**
   * Run one agent and return a schema-valid JSON value.
   *
   * External providers cannot take a structured-output tool, so it is enforced
   * here exactly as Workflow does it: instruct, parse, validate, retry (3 times).
   */
  async json<T>(call: SpecAgentCall, schema: Record<string, unknown>): Promise<T> {
    const instruction =
      'Respond with ONLY a single JSON object matching this JSON Schema. ' +
      `No prose, no explanation, no markdown fences:\n${JSON.stringify(schema)}`
    let prompt = `${call.prompt}\n\n${instruction}`
    let lastError = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
      const reply = await this.text({ ...call, label: attempt === 1 ? call.label : `${call.label} (retry ${attempt - 1})`, prompt })
      const parsed = parseJsonReply(reply)
      const verdict = validateValue(schema, parsed)
      if (verdict.ok) return parsed as T
      lastError = verdict.error
      prompt = `${call.prompt}\n\n${instruction}\n\nYour previous reply was invalid: ${lastError}. Return ONLY the corrected JSON object.`
    }
    throw new Error(`${call.label} produced no schema-valid output after 3 attempts: ${lastError}`)
  }

  private async run<T>(call: SpecAgentCall, finish: (reply: string) => T): Promise<T> {
    const { writer, signal } = this.ctx
    const index = this.nextIndex++
    const { providerId, modelId } = call.seat
    const source = call.cwd ?? this.ctx.cwd
    const agentId = newAgentId(providerId)
    writer.emit({
      kind: 'agent',
      index,
      patch: {
        taskId: agentId,
        label: call.label,
        phase: call.phase,
        state: 'running',
        agentType: providerId,
        modelId,
        startedAt: Date.now(),
      },
    })

    // The disposable worktree lands inside the change checkout; keep git from
    // ever seeing it there as an embedded repository.
    await excludeLocally(source, '.operon/worktrees/').catch(() => undefined)
    const worktree = await createWorktree(new LocalEnvironment(source), { label: agentId }).catch(() => null)
    if (!worktree) {
      writer.emit({ kind: 'log', message: `${call.label}: no disposable worktree — running read-only in the change worktree` })
    }
    try {
      const reply = await runProviderAgent({
        providerId,
        modelId,
        cwd: worktree?.cwd ?? source,
        prompt: `${call.prompt}\n\n${WORKSPACE_NOTE}`,
        agentId,
        title: call.label,
        workspaceId: this.ctx.workspaceId,
        parentChatId: this.ctx.chatId,
        onApproval: (request) => writer.emit({ kind: 'approval', approval: request }),
        onApprovalSettled: (approvalId) => writer.emit({ kind: 'approval-resolved', approvalId }),
        // Every spec role only reads. A read can still ask — OpenCode asks before
        // touching a path outside its checkout, e.g. one copied from the brief —
        // and nobody is watching to answer, so reads are let through.
        autoAllow: (toolName) => READ_TOOLS.has(toolName.toLowerCase()),
        onChats: (chatIds) => writer.emit({ kind: 'agent', index, patch: { chatIds } }),
        live: { runId: writer.runId, index },
        modelFor: this.ctx.modelFor,
        onReplaced: (from, to) => {
          // Labels name their provider ("candidate B · opencode"); keep the row honest.
          const suffix = ` · ${from.providerId}`
          const label = call.label.endsWith(suffix) ? `${call.label.slice(0, -suffix.length)} · ${to.providerId}` : call.label
          writer.emit({ kind: 'agent', index, patch: { label, agentType: to.providerId, modelId: to.modelId } })
          this.ctx.onSeatReplaced?.(call.seat, to)
        },
        signal,
      })
      if (!reply.trim()) {
        throw new Error(
          `${call.label} produced no output (provider "${providerId}"${modelId ? `, model "${modelId}"` : ''}). ` +
            'Its run in the Workflow tab shows how far it got and why it stopped.',
        )
      }
      const value = finish(reply)
      writer.emit({
        kind: 'agent',
        index,
        patch: { state: 'done', resultPreview: previewOf(reply), endedAt: Date.now() },
      })
      return value
    } catch (error) {
      writer.emit({
        kind: 'agent',
        index,
        patch: { state: 'error', error: error instanceof Error ? error.message : String(error), endedAt: Date.now() },
      })
      throw error
    } finally {
      if (worktree) await worktree.cleanup().catch(() => {})
    }
  }
}

