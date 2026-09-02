import { randomUUID } from 'crypto'
import type {
  ActiveRequest,
  DynamicSetApplied,
  DynamicSetPayload,
  PermissionDecision,
  ProviderInfo,
  RuntimeProviderFactory,
  RuntimeSession,
  RuntimeSessionParams,
  SessionDisposeReason,
  SessionRecord,
} from './types.js'

interface ProviderEntry {
  create: () => RuntimeProviderFactory
  info: ProviderInfo
}

/**
 * The settings an ordinary conversation actually changes, and the only ones a live
 * session has any chance of absorbing (`RuntimeSession.dynamicSet`). Kept out of the
 * structural key below: a difference here is an invitation to reconfigure, not a
 * reason to rebuild. Whether the reconfigure sticks is up to the runtime, which
 * reports back which fields it applied.
 */
const RECONFIGURABLE_FIELDS = ['modelId', 'modeId', 'thinkingLevel', 'serviceTier'] as const

type ReconfigurableField = (typeof RECONFIGURABLE_FIELDS)[number]

/**
 * Fields where `undefined` is a value rather than "not specified".
 *
 * For a model or a mode, a missing value means the caller is not asking for a
 * change. Fast mode is the opposite: absent IS the off state, so switching it off
 * arrives as `serviceTier: undefined` and has to be forwarded, not skipped.
 */
const CLEARABLE_FIELDS = new Set<ReconfigurableField>(['serviceTier'])

/**
 * Write one reconfigurable field into whichever of the two shapes carries it.
 *
 * `DynamicSetPayload` and `RuntimeSessionParams` declare these four fields
 * identically, but indexing either with a union key severs the tie between the key
 * and its value type — `serviceTier` is `'fast'` where the rest are plain strings —
 * and TypeScript refuses the write. The generic pins both sides to one `K`.
 */
function setField<K extends ReconfigurableField>(
  target: DynamicSetPayload | RuntimeSessionParams,
  field: K,
  value: RuntimeSessionParams[K],
): void {
  Object.assign(target, { [field]: value })
}

/**
 * Everything that is baked in at session creation. A difference here cannot be
 * expressed by the running session at all, so it forces a rebuild.
 *
 * In practice none of these move during a conversation — cwd is the workspace, env
 * is fixed, and mcpServers is derived from ids that do not change for a given chat
 * (it moves only when the user edits MCP settings, which is meant to rebuild).
 */
const buildStructuralKey = (params: RuntimeSessionParams): string =>
  JSON.stringify({
    cwd: params.cwd,
    env: params.env ?? {},
    // NOTE: serviceTier (fast mode) is NOT here — it moved up to the
    // reconfigurable fields. It is baked in for Claude, whose warm query reads it
    // at creation, but not for codex, which re-sends it with every `turn/start`.
    // Deciding centrally that it forces a rebuild was wrong for codex: it threw
    // away a live thread, restarted its SDK MCP servers, and released the shared
    // app-server lease — which can take an ephemeral side-chat fork with it.
    // `reconfigure` asks the provider instead, and rebuilds only if it says no.
    // MCP config is a session capability. In particular, node_repl contains the
    // conversation id in its URL; reusing a session with a different map would
    // silently leave the agent connected to the wrong persistent kernel.
    mcpServers: params.mcpServers ?? {},
    // NOTE: instructions is intentionally excluded. Ordinary chats never send it
    // (the frontend does not, and the route does not fill it in), so it only ever
    // read as '' there. Only channel agents pass a persona, and the trade-off taken
    // is that editing one no longer forces a rebuild — the new persona lands when
    // that session is next rebuilt for some other reason. It IS still part of the
    // Operon harness key, so two personas never share a harness.
    // NOTE: sessionId is intentionally excluded — it is runtime state produced by
    // the session (thread ID, Gemini session ID, etc.), not a configuration input.
    // Including it here caused the session to be destroyed and recreated on the
    // second message (key changes from '' → actual ID), which killed the
    // underlying process / cleaned up session files, making resume impossible.
  })

export class SessionManager {
  private sessions = new Map<number, SessionRecord>()
  private providers = new Map<string, ProviderEntry>()
  private externalPermissionResolver:
    | ((chatId: number, approvalId: string, decision: PermissionDecision) => boolean)
    | null = null

  register(providerId: string, create: () => RuntimeProviderFactory, info: ProviderInfo): void {
    this.providers.set(providerId, { create, info })
  }

  createProvider(providerId: string): RuntimeProviderFactory {
    const entry = this.providers.get(providerId)
    if (!entry) {
      throw new Error(`No runtime provider registered for: ${providerId}`)
    }
    return entry.create()
  }

  async createStandaloneSession(providerId: string, params: RuntimeSessionParams): Promise<RuntimeSession> {
    const provider = this.createProvider(providerId)
    return provider.createSession(params)
  }

  listProviders(): ProviderInfo[] {
    return Array.from(this.providers.values()).map((entry) => entry.info)
  }

  hasProvider(providerId: string): boolean {
    return this.providers.has(providerId)
  }

  /**
   * Let the embedding host resolve permission requests that originate outside a
   * provider stream (for example Browser Use inside the shared node_repl MCP).
   */
  setExternalPermissionResolver(
    resolver: (chatId: number, approvalId: string, decision: PermissionDecision) => boolean,
  ): void {
    this.externalPermissionResolver = resolver
  }

  *findByProvider(providerId: string): Iterable<SessionRecord> {
    for (const session of this.sessions.values()) {
      if (session.providerId === providerId) {
        yield session
      }
    }
  }

  /**
   * The live record whose runtime reports `sessionId` as its provider session — how a
   * host maps a framework session back to its chat before the id is persisted on the
   * chat row (that only happens once the turn ends). Linear scan: a handful of sessions.
   */
  findBySessionId(sessionId: string): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.runtime.getSessionId?.() === sessionId) return record
    }
    return undefined
  }

  async getOrCreate(chatId: number, providerId: string, params: RuntimeSessionParams): Promise<SessionRecord> {
    const current = this.sessions.get(chatId)
    const reusable =
      current !== undefined &&
      current.providerId === providerId &&
      buildStructuralKey(current.params) === buildStructuralKey(params)

    // Same shape of session — the only differences can be model / mode / effort, so
    // ask the runtime to take them in place. Rebuilding for these is what used to
    // tear down the CLI subprocess and reconnect every MCP server on a plain
    // "switch model and keep talking".
    if (reusable && (await this.reconfigure(current, params))) {
      return current
    }

    if (current) {
      // Same conversation, new session — tell the runtime so it keeps whatever the
      // conversation still needs (a side chat's fork) rather than cleaning it up.
      await this.destroy(chatId, 'rebuild')
    }

    const provider = this.createProvider(providerId)
    const runtime = await provider.createSession(params)
    const record: SessionRecord = {
      chatId,
      providerId,
      runtime,
      params,
      createdAt: Date.now(),
      activeRequest: null,
    }
    this.sessions.set(chatId, record)
    return record
  }

  /**
   * Try to bring a live session up to `next` without rebuilding it.
   *
   * Returns true only if the session now matches `next` in every reconfigurable
   * field — either because nothing differed, or because the runtime confirmed it
   * applied each difference. A partial result returns false and the caller rebuilds:
   * a session that took the new model but not the new effort is not the session the
   * request asked for, and pretending otherwise would silently drop the setting.
   */
  private async reconfigure(session: SessionRecord, next: RuntimeSessionParams): Promise<boolean> {
    const patch: DynamicSetPayload = {}
    const changed: DynamicSetApplied = []
    for (const field of RECONFIGURABLE_FIELDS) {
      const value = next[field]
      if (value === session.params[field]) continue
      if (value === undefined && !CLEARABLE_FIELDS.has(field)) continue
      setField(patch, field, value)
      changed.push(field)
    }
    if (changed.length === 0) return true
    if (typeof session.runtime.dynamicSet !== 'function') return false

    const applied = await session.runtime.dynamicSet(patch)
    if (!changed.every((field) => applied.includes(field))) return false

    Object.assign(session.params, patch)
    return true
  }

  /**
   * Fold a successful `dynamicSet` back into the record's params.
   *
   * The stored params ARE the reuse fingerprint (`buildParamsKey`). Switching model
   * or mode on a live session without updating them leaves the record describing a
   * configuration the session no longer has, so the very next turn compares the new
   * request against a stale key, decides the session is incompatible, and destroys
   * it — throwing away exactly the session the hot switch just avoided rebuilding.
   */
  applyDynamicParams(chatId: number, patch: DynamicSetPayload, applied: DynamicSetApplied): void {
    const session = this.sessions.get(chatId)
    if (!session) return
    // Only fold in what the session confirmed it changed. Recording a field the
    // runtime rejected (Claude cannot re-effort a live query) would suppress the
    // rebuild that is the only way to make that setting take.
    for (const field of applied) {
      const value = patch[field]
      // `serviceTier: undefined` is fast mode being switched off — a real applied
      // value, not a missing one — so it has to be folded in like any other.
      if (value === undefined && !CLEARABLE_FIELDS.has(field)) continue
      setField(session.params, field, value)
    }
  }

  startRequest(chatId: number, requestId?: string): ActiveRequest {
    const session = this.sessions.get(chatId)
    if (!session) {
      throw new Error(`No session found for chatId: ${chatId}`)
    }

    if (session.activeRequest) {
      session.activeRequest.abortController.abort()
    }

    const nextRequest: ActiveRequest = {
      requestId: requestId ?? randomUUID(),
      abortController: new AbortController(),
    }
    session.activeRequest = nextRequest
    return nextRequest
  }

  finishRequest(chatId: number, requestId: string): void {
    const session = this.sessions.get(chatId)
    if (!session) return
    if (session.activeRequest?.requestId === requestId) {
      session.activeRequest = null
    }
  }

  resolvePermission(chatId: number, approvalId: string, decision: PermissionDecision): boolean {
    if (this.externalPermissionResolver?.(chatId, approvalId, decision)) return true
    const session = this.sessions.get(chatId)
    if (!session) {
      return false
    }
    return session.runtime.resolvePermission(approvalId, decision)
  }

  get(chatId: number): SessionRecord | undefined {
    return this.sessions.get(chatId)
  }

  async destroy(chatId: number, reason: SessionDisposeReason = 'discard'): Promise<void> {
    const session = this.sessions.get(chatId)
    if (!session) return
    if (session.activeRequest) {
      session.activeRequest.abortController.abort()
    }
    await session.runtime.dispose(reason)
    this.sessions.delete(chatId)
  }

  async destroyAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys())
    await Promise.all(ids.map((chatId) => this.destroy(chatId)))
  }
}
