import type {
  PermissionDecision,
  ProviderDescriptor,
  ProviderInfo,
  RuntimeProviderFactory,
  RuntimeSession,
  RuntimeSessionParams,
  RuntimeStreamParams,
  RuntimeStreamPart,
} from '../../types.js'

/**
 * A fake script generator. The single-argument form
 * `(ctx: { params }) => AsyncIterable<RuntimeStreamPart>` is kept for backwards
 * compatibility with existing tests; new scripts can use `ctx.session` to wait
 * for permission decisions and `ctx.delay` to insert pauses.
 */
export type FakeScriptCtx = {
  params: RuntimeStreamParams
  session: FakeSessionState
  delay: (ms: number) => Promise<void>
}

export type FakeScript = (ctx: FakeScriptCtx) => AsyncIterable<RuntimeStreamPart>

/**
 * State exposed to a script for the duration of a single stream() call. Mirrors
 * the real provider permission flow: scripts can yield a `tool-approval-request`
 * and `await session.waitForPermission(approvalId)` to suspend until the user
 * resolves it via `RuntimeSession.resolvePermission`.
 */
export interface FakeSessionState {
  /** Last user message text (if any), extracted from `params.messages`. */
  readonly userMessage: string
  /** 0-based index of the current turn within this session. */
  readonly turnIndex: number
  /** Suspends the script until `resolvePermission(approvalId, ...)` is called. */
  waitForPermission(approvalId: string): Promise<PermissionDecision>
  /** Throws if the stream has been aborted. Use to cooperatively cancel. */
  throwIfAborted(): void
  /** True after `abort()` has been called on the session. */
  readonly aborted: boolean
}

interface PendingApproval {
  resolve: (decision: PermissionDecision) => void
  reject: (err: Error) => void
}

interface QueuedDecision {
  decision: PermissionDecision
}

class FakeRuntimeSession implements RuntimeSession {
  private aborted = false
  private turnIndex = -1
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly queuedDecisions = new Map<string, QueuedDecision>()
  private currentModelId: string
  private currentModeId: string

  constructor(params: RuntimeSessionParams) {
    this.currentModelId = params.modelId ?? 'fake-1'
    this.currentModeId = params.modeId ?? 'default'
  }

  async *stream(params: RuntimeStreamParams): AsyncIterable<RuntimeStreamPart> {
    this.aborted = false
    this.turnIndex += 1

    const scriptName = FakeRuntimeProvider.currentScript
    const script = FakeRuntimeProvider.scripts.get(scriptName)
    if (!script) {
      throw new Error(`No fake script registered: ${scriptName}`)
    }

    const userMessage = extractLastUserText(params.messages)
    const turnIndex = this.turnIndex
    const sessionState: FakeSessionState = {
      userMessage,
      turnIndex,
      aborted: false,
      waitForPermission: (approvalId) => this.waitForPermission(approvalId),
      throwIfAborted: () => {
        if (this.aborted) throw new AbortError()
      },
    }
    Object.defineProperty(sessionState, 'aborted', {
      get: () => this.aborted,
    })

    const delay = (ms: number): Promise<void> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup()
          if (this.aborted) reject(new AbortError())
          else resolve()
        }, ms)
        const onAbort = () => {
          clearTimeout(timer)
          cleanup()
          reject(new AbortError())
        }
        const signal = params.signal
        signal?.addEventListener('abort', onAbort)
        const cleanup = () => signal?.removeEventListener('abort', onAbort)
      })

    try {
      for await (const part of script({ params, session: sessionState, delay })) {
        if (this.aborted) return
        yield part
      }
    } catch (err) {
      if (err instanceof AbortError || this.aborted) return
      throw err
    } finally {
      this.rejectAllPending(new AbortError())
    }
  }

  abort(): void {
    this.aborted = true
    this.rejectAllPending(new AbortError())
  }

  async dispose(): Promise<void> {
    this.aborted = true
    this.rejectAllPending(new AbortError())
  }

  resolvePermission(approvalId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingApprovals.get(approvalId)
    if (pending) {
      this.pendingApprovals.delete(approvalId)
      pending.resolve(decision)
      return true
    }
    // Decision arrived before the script reached waitForPermission. Queue it so
    // the next waitForPermission(approvalId) can consume it synchronously.
    this.queuedDecisions.set(approvalId, { decision })
    return true
  }

  async injectMessage(_content: string): Promise<void> {
    // no-op
  }

  getDescriptorPatch(): {
    currentModelId: string
    currentModeId: string
  } {
    return {
      currentModelId: this.currentModelId,
      currentModeId: this.currentModeId,
    }
  }

  private waitForPermission(approvalId: string): Promise<PermissionDecision> {
    if (this.aborted) return Promise.reject(new AbortError())
    const queued = this.queuedDecisions.get(approvalId)
    if (queued) {
      this.queuedDecisions.delete(approvalId)
      return Promise.resolve(queued.decision)
    }
    return new Promise((resolve, reject) => {
      this.pendingApprovals.set(approvalId, { resolve, reject })
    })
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pendingApprovals) pending.reject(err)
    this.pendingApprovals.clear()
  }
}

class AbortError extends Error {
  constructor() {
    super('fake script aborted')
    this.name = 'AbortError'
  }
}

function extractLastUserText(messages: RuntimeStreamParams['messages']): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg || msg.role !== 'user') continue
    const content = msg.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const textPart = content.find(
        (p): p is { type: 'text'; text: string } =>
          typeof p === 'object' && p !== null && (p as { type?: string }).type === 'text',
      )
      if (textPart) return textPart.text
    }
    return ''
  }
  return ''
}

const BUILTIN_DEFAULT_SCRIPT: FakeScript = async function* () {
  yield { type: 'text-start', id: 'fake-1' } as RuntimeStreamPart
  yield { type: 'text-delta', id: 'fake-1', text: 'Hello from fake runtime.' } as RuntimeStreamPart
  yield { type: 'text-end', id: 'fake-1' } as RuntimeStreamPart
  yield {
    type: 'finish',
    finishReason: 'stop',
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  } as RuntimeStreamPart
}

export class FakeRuntimeProvider implements RuntimeProviderFactory {
  static readonly providerInfo: ProviderInfo = {
    id: 'fake',
    label: 'Fake',
    logo: 'fake',
  }

  static readonly scripts = new Map<string, FakeScript>([['default', BUILTIN_DEFAULT_SCRIPT]])
  static currentScript = 'default'

  static resetScripts(): void {
    FakeRuntimeProvider.scripts.clear()
    FakeRuntimeProvider.scripts.set('default', BUILTIN_DEFAULT_SCRIPT)
    FakeRuntimeProvider.currentScript = 'default'
    // Re-install built-in provider-style scripts on reset so tests can rely on
    // them being available without re-importing the registry every time.
    installBuiltinProviderScripts()
  }

  readonly providerInfo = FakeRuntimeProvider.providerInfo

  async getDescriptor(): Promise<ProviderDescriptor> {
    return {
      id: 'fake',
      label: 'Fake',
      logo: 'fake',
      models: [{ id: 'fake-1', name: 'Fake 1' }],
      modes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }],
      thinkingLevels: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
      commands: [],
      slashCommands: [
        { name: 'compact', description: 'Compact context', type: 'command' },
        { name: 'plan', description: 'Plan mode', type: 'command' },
        { name: 'help', description: 'Show help', type: 'command' },
      ],
      currentModelId: 'fake-1',
      currentModeId: 'default',
      features: {
        permissions: true,
        attachments: true,
        injection: true,
        sessionResume: false,
      },
    }
  }

  async createSession(params: RuntimeSessionParams): Promise<RuntimeSession> {
    return new FakeRuntimeSession(params)
  }
}

// Lazy hook so `installBuiltinProviderScripts` (defined in scripts/index.ts) can
// be re-applied on reset without creating an import cycle at module load time.
let installBuiltinProviderScripts: () => void = () => {}

export function setBuiltinScriptInstaller(fn: () => void): void {
  installBuiltinProviderScripts = fn
  fn()
}
