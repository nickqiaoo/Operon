/**
 * The prompt of a warm query: an async iterable that stays open across turns,
 * like Claude Desktop's AsyncMessageQueue. Shared by the SDK-driven providers
 * whose `query()` takes an AsyncIterable of user messages (Claude Code, Qoder).
 */
export class PersistentInputQueue<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private resolver: ((msg: T | null) => void) | null = null
  private closed = false

  enqueue(msg: T): void {
    if (this.closed) return
    if (this.resolver) {
      const r = this.resolver
      this.resolver = null
      r(msg)
    } else {
      this.queue.push(msg)
    }
  }

  close(): void {
    this.closed = true
    if (this.resolver) {
      const r = this.resolver
      this.resolver = null
      r(null)
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (!this.closed) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!
      } else {
        const msg = await new Promise<T | null>((resolve) => {
          this.resolver = resolve
        })
        if (msg === null) break
        yield msg
      }
    }
  }
}
