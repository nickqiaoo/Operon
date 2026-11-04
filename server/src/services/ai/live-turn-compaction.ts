// Shrinks a buffered UI message stream without changing what it rebuilds.
//
// The live-turn hub keeps a turn's SSE events so a late attacher can replay the
// turn from its first chunk. Most of a long turn's bytes are delta envelopes:
// every few characters of text or reasoning, every fragment of a tool call's
// input, each one its own `data: {"type":"text-delta",...}` event. The AI SDK
// folds those into the part they belong to, so all the deltas of one part can be
// folded here first — into the position of the part's first delta — and the
// replay still rebuilds the same message.
//
// Also dropped: a preliminary tool output that a later output of the same call
// replaces (the SDK keeps only the latest).
//
// Every other event is kept byte for byte, in order. Nothing is dropped from the
// head, which is what used to break a replay: the stream lost its `start` and
// the `*-start` of parts it still had deltas for, and the SDK rejects a delta
// whose part it never saw.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const DATA_PREFIX = 'data: '
const EVENT_SUFFIX = '\n\n'

type Chunk = Record<string, unknown> & { type: string }

interface Fold {
  chunk: Chunk
  field: 'delta' | 'inputTextDelta'
  pieces: string[]
}

type Slot = Uint8Array | Fold | null

/** The chunk in one SSE event, or undefined when it is not a JSON `data:` event. */
export function parseSseEvent(event: Uint8Array): Chunk | undefined {
  const text = decoder.decode(event)
  if (!text.startsWith(DATA_PREFIX) || !text.endsWith(EVENT_SUFFIX)) return undefined
  const body = text.slice(DATA_PREFIX.length, -EVENT_SUFFIX.length)
  if (!body.startsWith('{')) return undefined
  try {
    const chunk: unknown = JSON.parse(body)
    if (chunk && typeof chunk === 'object' && typeof (chunk as { type?: unknown }).type === 'string') {
      return chunk as Chunk
    }
  } catch {
    // not ours to fold
  }
  return undefined
}

export function encodeSseEvent(chunk: unknown): Uint8Array {
  return encoder.encode(`${DATA_PREFIX}${JSON.stringify(chunk)}${EVENT_SUFFIX}`)
}

const deltaKey = (chunk: Chunk): { key: string; field: Fold['field'] } | undefined => {
  switch (chunk.type) {
    case 'text-delta':
      return { key: `text:${String(chunk.id)}`, field: 'delta' }
    case 'reasoning-delta':
      return { key: `reasoning:${String(chunk.id)}`, field: 'delta' }
    case 'tool-input-delta':
      return { key: `tool:${String(chunk.toolCallId)}`, field: 'inputTextDelta' }
    default:
      return undefined
  }
}

/** The part a chunk opens or closes, ending any fold of that part. */
const boundaryKey = (chunk: Chunk): string | undefined => {
  switch (chunk.type) {
    case 'text-start':
    case 'text-end':
      return `text:${String(chunk.id)}`
    case 'reasoning-start':
    case 'reasoning-end':
      return `reasoning:${String(chunk.id)}`
    case 'tool-input-start':
    case 'tool-input-available':
    case 'tool-input-error':
      return `tool:${String(chunk.toolCallId)}`
    default:
      return undefined
  }
}

const isToolOutput = (chunk: Chunk): boolean =>
  chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error' || chunk.type === 'tool-output-denied'

/** Fold the deltas in `events` (complete SSE events, in stream order). */
export function compactSseEvents(events: readonly Uint8Array[]): Uint8Array[] {
  const slots: Slot[] = []
  const openFolds = new Map<string, Fold>()
  /** Slot of each tool call's latest preliminary output, superseded by any later output. */
  const preliminary = new Map<string, number>()

  for (const event of events) {
    const chunk = parseSseEvent(event)
    if (!chunk) {
      slots.push(event)
      continue
    }

    const delta = deltaKey(chunk)
    if (delta) {
      const piece = chunk[delta.field]
      if (typeof piece !== 'string') {
        slots.push(event)
        continue
      }
      const fold = openFolds.get(delta.key)
      if (fold) {
        fold.pieces.push(piece)
        // The SDK keeps the latest provider metadata a delta carries.
        if (chunk.providerMetadata != null) fold.chunk.providerMetadata = chunk.providerMetadata
        continue
      }
      const created: Fold = { chunk: { ...chunk }, field: delta.field, pieces: [piece] }
      openFolds.set(delta.key, created)
      slots.push(created)
      continue
    }

    const boundary = boundaryKey(chunk)
    if (boundary) openFolds.delete(boundary)

    if (isToolOutput(chunk) && typeof chunk.toolCallId === 'string') {
      const earlier = preliminary.get(chunk.toolCallId)
      if (earlier !== undefined) slots[earlier] = null
      if (chunk.type === 'tool-output-available' && chunk.preliminary === true) {
        preliminary.set(chunk.toolCallId, slots.length)
      } else {
        preliminary.delete(chunk.toolCallId)
      }
    }

    slots.push(event)
  }

  const out: Uint8Array[] = []
  for (const slot of slots) {
    if (slot === null) continue
    if (slot instanceof Uint8Array) {
      out.push(slot)
      continue
    }
    if (slot.pieces.length === 1) {
      out.push(encodeSseEvent(slot.chunk))
      continue
    }
    out.push(encodeSseEvent({ ...slot.chunk, [slot.field]: slot.pieces.join('') }))
  }
  return out
}
