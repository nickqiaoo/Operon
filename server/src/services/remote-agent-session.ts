import {
  getSessionIdFromProviderMetadata, RuntimeInjectionUnavailableError,
  type AgentInput, type AgentSession, type InjectOptions, type InputDeliveryReceipt, type PermissionDecision, type ProviderFeatures,
  type RuntimeStreamPart, type SendOptions, type SessionCloseReason, type SessionPatch, type SessionPatchApplied, type SessionState,
} from '@operon/agent-runtime'
import {
  decodeWire, encodeWire, type DelegationControl, type DelegationControlResult, type DelegationFrame, type DelegationSessionOptions,
  type RemoteExecutionRef,
} from '@shared/delegations'
import { DelegationHttpError, delegationRequest, delegationStream } from './delegation-transport.js'

/**
 * An agent session that runs on another machine (see shared/delegations.ts).
 *
 * To the chat that owns it this is just another provider session: turns stream
 * the remote runtime's parts unchanged, approvals and live settings are relayed,
 * and the provider's native session id rides the parts' metadata as usual, so the
 * origin persists it and resumes the same thread after either side restarts.
 *
 * The optional members follow what the provider declares on the target machine,
 * because hosts read their presence as the capability (`runtime.steer ? … : …`).
 */
export class RemoteAgentSession implements AgentSession {
  private remoteState: SessionState = {}
  private readonly options: DelegationSessionOptions
  private turn?: AbortController
  private readonly pendingApprovals = new Set<string>()
  private sessionId: string | undefined

  readonly set?: (patch: SessionPatch) => Promise<SessionPatchApplied>
  readonly steer?: (input: AgentInput, options?: InjectOptions) => Promise<InputDeliveryReceipt>
  readonly followup?: (input: AgentInput, options?: InjectOptions) => Promise<InputDeliveryReceipt>

  constructor(
    private readonly providerId: string,
    private readonly target: RemoteExecutionRef,
    options: DelegationSessionOptions,
    features: Partial<ProviderFeatures> = {},
  ) {
    this.options = { ...options }
    this.sessionId = options.resume
    if (features.dynamicSwitch) this.set = (patch) => this.applySettings(patch)
    if (features.steer) this.steer = (input, inject) => this.deliver('steer', input, inject)
    if (features.followup) this.followup = (input, inject) => this.deliver('followup', input, inject)
  }

  get id(): string | undefined { return this.sessionId }

  private path(action: 'turn' | 'control'): string {
    return `/api/delegations/sessions/${this.target.sessionId}/${action}`
  }

  private control(control: DelegationControl): Promise<DelegationControlResult> {
    return delegationRequest<DelegationControlResult>(this.target.nodeId, this.path('control'), encodeWire(control))
  }

  async *send(input: AgentInput, options?: SendOptions): AsyncIterable<RuntimeStreamPart> {
    this.turn?.abort()
    const turn = new AbortController()
    this.turn = turn
    const signal = options?.signal ? AbortSignal.any([options.signal, turn.signal]) : turn.signal
    const body = encodeWire({
      providerId: this.providerId, workspaceId: this.target.workspaceId,
      options: { ...this.options, resume: this.sessionId }, input,
    })
    try {
      for await (const data of delegationStream(this.target.nodeId, this.path('turn'), body, signal)) {
        const frame = decodeWire<DelegationFrame>(data)
        if (frame.type === 'state') {
          this.remoteState = frame.state as SessionState
          continue
        }
        if (frame.type === 'error') throw new Error(frame.message)
        const part = frame.part as RuntimeStreamPart
        if (part.type === 'tool-approval-request') this.pendingApprovals.add(part.approvalId)
        const sessionId = 'providerMetadata' in part ? getSessionIdFromProviderMetadata(part.providerMetadata) : undefined
        if (sessionId) this.sessionId = sessionId
        yield part
      }
    } catch (error) {
      if (signal.aborted) return
      throw error
    } finally {
      if (this.turn === turn) this.turn = undefined
      this.pendingApprovals.clear()
    }
  }

  abort(): void {
    this.turn?.abort()
    // Closing the stream already stops the remote turn; say so explicitly in case the stream is wedged.
    void this.control({ type: 'abort' }).catch(() => undefined)
  }

  async close(reason?: SessionCloseReason): Promise<void> {
    this.turn?.abort()
    // A rebuild keeps the remote thread: the next session resumes it by id.
    if (reason === 'rebuild') return
    await this.control({ type: 'close' }).catch(() => undefined)
  }

  respond(approvalId: string, decision: PermissionDecision): boolean {
    if (!this.pendingApprovals.delete(approvalId)) return false
    // The interface is synchronous; the answer reaches the agent over the network.
    void this.control({ type: 'respond', approvalId, decision }).then((result) => {
      if (!result.accepted) console.warn(`[remote-agent] ${this.target.machine} no longer waits for approval ${approvalId}`)
    }).catch((error) => console.warn('[remote-agent] could not deliver an approval:', error))
    return true
  }

  private async applySettings(patch: SessionPatch): Promise<SessionPatchApplied> {
    const wire = { ...patch, ...('serviceTier' in patch ? { serviceTier: patch.serviceTier ?? null } : {}) }
    const fields = Object.keys(patch) as SessionPatchApplied
    // Between turns the target may have no live session: the next turn carries the settings.
    const result: DelegationControlResult = await this.control({ type: 'set', patch: wire }).catch((error: unknown) => {
      if (error instanceof DelegationHttpError && error.code === 'session_missing') return { ok: true as const, applied: fields }
      throw error
    })
    const applied = (result.applied ?? []) as SessionPatchApplied
    for (const field of applied) Object.assign(this.options, { [field]: patch[field] })
    if (result.state) this.remoteState = result.state as SessionState
    return applied
  }

  state(): SessionState { return this.remoteState }

  private async deliver(type: 'steer' | 'followup', input: AgentInput, options?: InjectOptions): Promise<InputDeliveryReceipt> {
    try {
      const result = await this.control({ type, input, id: options?.id })
      return result.receipt as InputDeliveryReceipt
    } catch (error) {
      if (error instanceof DelegationHttpError && (error.code === 'injection_unavailable' || error.code === 'session_missing')) {
        throw new RuntimeInjectionUnavailableError(error.message)
      }
      throw error
    }
  }
}

/** What `GET /api/ai/providers/:id/models` answers, here read from the machine the agent runs on. */
export interface RemoteProviderModels {
  features?: Partial<ProviderFeatures>
  [key: string]: unknown
}

const MODELS_TTL_MS = 30_000
const remoteModels = new Map<string, { at: number; value: Promise<RemoteProviderModels> }>()

/** The provider's model / mode catalog on another machine, briefly cached. */
export function remoteProviderModels(nodeId: string, providerId: string): Promise<RemoteProviderModels> {
  const key = `${nodeId}:${providerId}`
  const cached = remoteModels.get(key)
  if (cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.value
  const value = delegationRequest<RemoteProviderModels>(nodeId, `/api/delegations/providers/${encodeURIComponent(providerId)}/models`)
  value.catch(() => { if (remoteModels.get(key)?.value === value) remoteModels.delete(key) })
  remoteModels.set(key, { at: Date.now(), value })
  return value
}

export async function createRemoteAgentSession(
  providerId: string, target: RemoteExecutionRef, options: DelegationSessionOptions,
): Promise<RemoteAgentSession> {
  // Its capabilities decide which members the session exposes; an unreachable
  // machine still gets a session, whose first turn reports the failure.
  const features = await remoteProviderModels(target.nodeId, providerId).then((models) => models.features, () => undefined)
  const { model, mode, effort, serviceTier, resume } = options
  return new RemoteAgentSession(providerId, target, { model, mode, effort, serviceTier, resume }, features)
}
