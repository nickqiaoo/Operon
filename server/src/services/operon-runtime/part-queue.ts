import type { RuntimeStreamPart } from '@operon/agent-runtime'

/** Minimal single-consumer async queue used to merge run events + approval prompts. */
export class PartQueue {
  private readonly buffer: RuntimeStreamPart[] = []
  private waiter: ((r: IteratorResult<RuntimeStreamPart>) => void) | undefined
  private closed = false

  push(part: RuntimeStreamPart): void {
    if (this.closed) return
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w({ value: part, done: false })
    } else {
      this.buffer.push(part)
    }
  }

  close(): void {
    this.closed = true
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeStreamPart> {
    return {
      next: (): Promise<IteratorResult<RuntimeStreamPart>> => {
        if (this.buffer.length > 0) return Promise.resolve({ value: this.buffer.shift() as RuntimeStreamPart, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => (this.waiter = resolve))
      },
    }
  }
}
