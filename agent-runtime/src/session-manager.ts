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
const RECONFIGURABLE_FIELDS = ['modelId', 'modeId', 'thinkingLevel'] as const

/**
 * Everything that is baked in at session creation. A difference here cannot be
 * expressed by the running session at all, so it forces a rebuild.
 *
 * In practice none of these move during a conversation — cwd is the workspace, env
 * is fixed, mcpServers is derived from ids that do not change for a given chat, and
 * serviceTier only moves when the user toggles fast mode (which no runtime can apply
 * live, so it belongs here rather than above).
 */
const buildStructuralKey = (params: RuntimeSessionParams): string =>
  JSON.stringify({
    cwd: params.cwd,
    env: params.env ?? {},
    serviceTier: params.serviceTier ?? '',
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
      await this.destroy(chatId)
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
      if (value !== undefined && value !== session.params[field]) {
        patch[field] = value
        changed.push(field)
      }
    }
    if (changed.length === 0) return true
    if (typeof session.runtime.dynamicSet !== 'function') return false

    const applied = await session.runtime.dynamicSet(patch)
    if (!changed.every((field) => applied.includes(field))) return false

    for (const field of changed) session.params[field] = patch[field]
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
      if (value !== undefined) session.params[field] = value
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

  async destroy(chatId: number): Promise<void> {
    const session = this.sessions.get(chatId)
    if (!session) return
    if (session.activeRequest) {
      session.activeRequest.abortController.abort()
    }
    await session.runtime.dispose()
    this.sessions.delete(chatId)
  }

  async destroyAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys())
    await Promise.all(ids.map((chatId) => this.destroy(chatId)))
  }
}
