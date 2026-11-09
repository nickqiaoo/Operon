import { inputText } from './utils/agent-input.js'
import { addUsage } from './utils/add-usage.js'
import { STOPPED_EXECUTION_WAIT_MS, settledWithin } from './utils/settled-within.js'
import { RuntimeInjectionUnavailableError, type AgentInput, type InjectOptions, type InputDeliveryReceipt, type RuntimeStreamPart, type SendOptions } from './types.js'

type FinishPart = Extract<RuntimeStreamPart, { type: 'finish' }>
type ErrorPart = Extract<RuntimeStreamPart, { type: 'error' }>

interface Run {
  stopped: boolean
  pending: Array<{ input: AgentInput; options?: InjectOptions }>
  settled: Promise<void>
}

function stop(run: Run): void {
  run.stopped = true
  run.pending = []
}

/** Compatibility only for protocols without a native followup API (Codex/ACP).
 * Keeps subsequent prompts on the caller's existing stream. Native queues do not use this.
 */
export class QueuedFollowup {
  private current: Run | undefined

  accept(input: AgentInput, options?: InjectOptions): InputDeliveryReceipt {
    const run = this.current
    if (!run || run.stopped) throw new RuntimeInjectionUnavailableError('No active execution for followup')
    run.pending.push({ input, options })
    return { delivery: 'accepted', mode: 'followup', ...(options?.id ? { id: options.id } : {}) }
  }

  cancel(): void {
    if (this.current) stop(this.current)
  }

  async *run(input: AgentInput, options: SendOptions | undefined,
    send: (input: AgentInput, options?: SendOptions) => AsyncIterable<RuntimeStreamPart>,
  ): AsyncIterable<RuntimeStreamPart> {
    const previous = this.current
    let settle!: () => void
    const run: Run = { stopped: false, pending: [], settled: new Promise<void>((resolve) => { settle = resolve }) }
    this.current = run
    const abort = () => stop(run)
    options?.signal?.addEventListener('abort', abort, { once: true })
    let started = false
    let finish: FinishPart | undefined
    let totalUsage: FinishPart['totalUsage'] | undefined
    let deferredError: ErrorPart | undefined
    try {
      if (previous) {
        stop(previous)
        await settledWithin(previous.settled, STOPPED_EXECUTION_WAIT_MS)
      }
      let next: AgentInput | undefined = input
      while (next !== undefined && !run.stopped && !options?.signal?.aborted) {
        finish = undefined
        try {
          for await (const part of send(next, options)) {
            if (part.type === 'start') {
              if (started) continue
              started = true
            }
            if (part.type === 'finish') {
              totalUsage = totalUsage ? addUsage(totalUsage, part.totalUsage) : part.totalUsage
              finish = { ...part, totalUsage }
              continue
            }
            // An error chunk ends the client's stream, so it waits until the queued input has run.
            if (part.type === 'error') {
              deferredError ??= part
              continue
            }
            if (part.type === 'abort') stop(run)
            yield part
          }
        } catch (error) {
          if (!run.pending.length) throw error
          deferredError ??= { type: 'error', error }
        }
        const queued = run.stopped ? undefined : run.pending.shift()
        next = queued?.input
        if (queued?.options?.id) yield { type: 'injected-input', id: queued.options.id, text: inputText(queued.input) }
      }
      stop(run)
      if (deferredError) yield deferredError
      if (finish) yield finish
    } finally {
      if (this.current === run) this.current = undefined
      stop(run)
      settle()
      options?.signal?.removeEventListener('abort', abort)
    }
  }
}
