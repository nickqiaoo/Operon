// The reply a turn stream has produced so far, kept as the shortest UI chunk
// sequence that rebuilds it.
//
// A viewer that attaches mid-turn needs the reply as it stands, then the chunks
// that follow. It cannot be handed the assembled `UIMessage`: the AI SDK keys
// every later delta by the stream id of the part it extends (`text-delta { id }`),
// and a `UIMessage`'s parts do not record those ids, so the next delta would
// have nowhere to go. A chunk sequence keeps them. Folded as chunks arrive, it
// stays about the size of the reply itself:
//
//   - the deltas of one text / reasoning / tool-input part collapse into one, at
//     the position of the part's first delta (the part stays open if it is);
//   - a preliminary tool output is dropped once a later output of that call
//     replaces it (the SDK keeps only the latest);
//   - a data part with an id replaces the earlier one in place (the SDK updates
//     the part it already has).
//
// Everything else is kept as it came, in order. The head is never dropped: the
// SDK rejects a delta whose part it never saw start, and needs `start` to know
// which message it is rebuilding.

import type { UIMessageChunk } from 'ai'

type Field = 'delta' | 'inputTextDelta'

/** What a chunk folds into, if it is a delta. */
function deltaTarget(chunk: UIMessageChunk): { key: string; field: Field } | undefined {
  switch (chunk.type) {
    case 'text-delta':
      return { key: `text:${chunk.id}`, field: 'delta' }
    case 'reasoning-delta':
      return { key: `reasoning:${chunk.id}`, field: 'delta' }
    case 'tool-input-delta':
      return { key: `tool:${chunk.toolCallId}`, field: 'inputTextDelta' }
    default:
      return undefined
  }
}

/** The part a chunk opens or closes, ending any fold into it. */
function boundaryKey(chunk: UIMessageChunk): string | undefined {
  switch (chunk.type) {
    case 'text-start':
    case 'text-end':
      return `text:${chunk.id}`
    case 'reasoning-start':
    case 'reasoning-end':
      return `reasoning:${chunk.id}`
    case 'tool-input-start':
    case 'tool-input-available':
    case 'tool-input-error':
      return `tool:${chunk.toolCallId}`
    default:
      return undefined
  }
}

function isToolOutput(chunk: UIMessageChunk): chunk is Extract<
  UIMessageChunk,
  { type: 'tool-output-available' | 'tool-output-error' | 'tool-output-denied' }
> {
  return chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error' || chunk.type === 'tool-output-denied'
}

/** A persistent data part (`data-*` with an id): the SDK replaces it by type + id. */
function dataPartKey(chunk: UIMessageChunk): string | undefined {
  if (!chunk.type.startsWith('data-')) return undefined
  const { id, transient } = chunk as { id?: unknown; transient?: unknown }
  if (typeof id !== 'string' || transient === true) return undefined
  return `${chunk.type}:${id}`
}

type Mutable = Record<string, unknown>

export class ChunkFold {
  /** Folded chunks in stream order; null where a chunk was superseded. Owned copies — never shared out. */
  private slots: Array<UIMessageChunk | null> = []
  private openDeltas = new Map<string, number>()
  private preliminaryOutputs = new Map<string, number>()
  private dataParts = new Map<string, number>()

  add(chunk: UIMessageChunk): void {
    const delta = deltaTarget(chunk)
    if (delta) {
      const piece = (chunk as Mutable)[delta.field]
      const index = this.openDeltas.get(delta.key)
      if (index !== undefined && typeof piece === 'string') {
        const slot = this.slots[index] as Mutable
        slot[delta.field] = `${slot[delta.field] as string}${piece}`
        // The SDK keeps the latest provider metadata a delta carries.
        const providerMetadata = (chunk as Mutable).providerMetadata
        if (providerMetadata != null) slot.providerMetadata = providerMetadata
        return
      }
      this.openDeltas.set(delta.key, this.slots.length)
      this.slots.push({ ...chunk })
      return
    }

    const boundary = boundaryKey(chunk)
    if (boundary) this.openDeltas.delete(boundary)

    if (isToolOutput(chunk)) {
      const earlier = this.preliminaryOutputs.get(chunk.toolCallId)
      if (earlier !== undefined) this.slots[earlier] = null
      if (chunk.type === 'tool-output-available' && chunk.preliminary === true) {
        this.preliminaryOutputs.set(chunk.toolCallId, this.slots.length)
      } else {
        this.preliminaryOutputs.delete(chunk.toolCallId)
      }
    }

    const dataKey = dataPartKey(chunk)
    if (dataKey) {
      const index = this.dataParts.get(dataKey)
      if (index !== undefined) {
        this.slots[index] = { ...chunk }
        return
      }
      this.dataParts.set(dataKey, this.slots.length)
    }

    this.slots.push({ ...chunk })
  }

  /**
   * The folded sequence, as copies: an open fold keeps growing after this
   * returns, and a reader still holding the copy must not see text it will
   * also receive as a later delta.
   */
  chunks(): UIMessageChunk[] {
    const out: UIMessageChunk[] = []
    for (const slot of this.slots) if (slot) out.push({ ...slot })
    return out
  }
}
