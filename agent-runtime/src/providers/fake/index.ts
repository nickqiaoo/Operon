import { defineProvider } from '../../runtime.js'
import type {
  AgentInput,
  AgentSession,
  PermissionDecision,
  ProviderDescriptor,
  ProviderInfo,
  RuntimeProviderFactory,
  RuntimeStreamPart,
  SendOptions,
  SessionOptions,
} from '../../types.js'
import { inputText } from '../../utils/agent-input.js'

/**
 * A fake script generator: given the turn's input, yields the parts the turn
 * streams. `ctx.session` waits for permission decisions, `ctx.delay` inserts
 * pauses.
 */
export type FakeScriptCtx = {
  input: AgentInput
  signal?: AbortSignal
  session: FakeSessionState
  delay: (ms: number) => Promise<void>
}

export type FakeScript = (ctx: FakeScriptCtx) => AsyncIterable<RuntimeStreamPart>

/**
 * State exposed to a script for the duration of a single send() call. Mirrors
 * the real provider permission flow: scripts can yield a `tool-approval-request`
 * and `await session.waitForPermission(approvalId)` to suspend until the user
 * resolves it via `AgentSession.respond`.
 */
export interface FakeSessionState {
  /** The turn's input text. */
  readonly userMessage: string
  /** 0-based index of the current turn within this session. */
  readonly turnIndex: number
  /** Suspends the script until `respond(approvalId, ...)` is called. */
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

class FakeRuntimeSession implements AgentSession {
  private aborted = false
  private turnIndex = -1
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly queuedDecisions = new Map<string, QueuedDecision>()
  private currentModelId: string
  private currentModeId: string

  constructor(params: SessionOptions) {
    this.currentModelId = params.model ?? 'fake-1'
    this.currentModeId = params.mode ?? 'default'
  }

  readonly id = undefined

  async *send(input: AgentInput, options?: SendOptions): AsyncIterable<RuntimeStreamPart> {
    this.aborted = false
    this.turnIndex += 1

    const scriptName = FakeRuntimeProvider.currentScript
    const script = FakeRuntimeProvider.scripts.get(scriptName)
    if (!script) {
      throw new Error(`No fake script registered: ${scriptName}`)
    }

    const userMessage = inputText(input)
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
        const signal = options?.signal
        signal?.addEventListener('abort', onAbort)
        const cleanup = () => signal?.removeEventListener('abort', onAbort)
      })

    try {
      for await (const part of script({ input, signal: options?.signal, session: sessionState, delay })) {
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

  async close(): Promise<void> {
    this.aborted = true
    this.rejectAllPending(new AbortError())
  }

  respond(approvalId: string, decision: PermissionDecision): boolean {
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

  async inject(_content: string): Promise<void> {
    // no-op
  }

  state(): {
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

  async createSession(params: SessionOptions): Promise<AgentSession> {
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

/**
 * A scriptable stand-in agent for tests: no CLI, no network. Pick the script
 * with `FakeRuntimeProvider.currentScript` (built-ins in `BUILTIN_SCRIPT_NAMES`).
 */
export const fakeAgent = () =>
  defineProvider<'fake', { mode: 'default' | 'plan'; effort: never }>({
    id: 'fake',
    info: FakeRuntimeProvider.providerInfo,
    create: () => new FakeRuntimeProvider(),
  })
