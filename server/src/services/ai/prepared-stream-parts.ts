import type { RuntimeTextStreamPart } from '@operon/agent-runtime'
import { readStreamAsAsyncIterable } from '@operon/agent-runtime'

export type PreparedTextStreamPart<METADATA = Record<string, unknown> | undefined> = {
  part?: RuntimeTextStreamPart
  metadata?: METADATA
}

export async function* readPreparedTextStreamParts(
  stream: ReadableStream<PreparedTextStreamPart>
): AsyncIterable<RuntimeTextStreamPart> {
  for await (const item of readStreamAsAsyncIterable(stream)) {
    if (item.part) {
      yield item.part
    }
  }
}
