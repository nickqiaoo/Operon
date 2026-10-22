import type { OpenCodeEvent } from '@opencode/client'
import type { OpencodeEvent, ToolPart } from './event-stream.js'

/** Adapt native V2 events to the transcript renderer's existing part contract. */
export class NativeEventAdapter {
  private readonly content = new Map<string, string>()
  private readonly tools = new Map<string, ToolPart>()

  convert(event: OpenCodeEvent): OpencodeEvent[] {
    const emitPart = (part: object): OpencodeEvent[] => [
      { type: 'message.part.updated', properties: { part } },
    ]
    switch (event.type) {
      case 'session.created':
        return [{ type: 'session.created', properties: { info: { id: event.data.sessionID, parentID: event.data.parentID } } }]
      case 'session.step.started': {
        const data = event.data
        return [
          { type: 'message.updated', properties: { info: { id: data.assistantMessageID, sessionID: data.sessionID, role: 'assistant', agent: data.agent } } },
          ...emitPart({ id: `${data.assistantMessageID}-step`, sessionID: data.sessionID, messageID: data.assistantMessageID, type: 'step-start' }),
        ]
      }
      case 'session.text.started':
      case 'session.text.delta':
      case 'session.text.ended':
      case 'session.reasoning.started':
      case 'session.reasoning.delta':
      case 'session.reasoning.ended': {
        const data = event.data
        const type = event.type.startsWith('session.text.') ? 'text' : 'reasoning'
        const id = `${data.assistantMessageID}-${type}-${data.ordinal}`
        const text = 'delta' in data
          ? (this.content.get(id) ?? '') + data.delta
          : 'text' in data ? data.text : ''
        this.content.set(id, text)
        return emitPart({ id, sessionID: data.sessionID, messageID: data.assistantMessageID, type, text })
      }
      case 'session.tool.input.started': {
        const data = event.data
        const part: ToolPart = {
          id: data.id, callID: data.id, sessionID: data.sessionID,
          messageID: data.assistantMessageID, type: 'tool', tool: data.name,
          state: { status: 'pending', input: {}, raw: '' },
        }
        this.tools.set(data.id, part)
        return emitPart(part)
      }
      case 'session.tool.input.delta': {
        const part = this.tools.get(event.data.id)
        if (!part || part.state.status !== 'pending') return []
        part.state = { ...part.state, raw: part.state.raw + event.data.delta }
        return emitPart(part)
      }
      case 'session.tool.input.ended': {
        const part = this.tools.get(event.data.id)
        if (!part || part.state.status !== 'pending') return []
        part.state = { ...part.state, raw: event.data.text }
        return emitPart(part)
      }
      case 'session.tool.called': {
        const part = this.tools.get(event.data.id)
        if (!part) return []
        part.state = { status: 'running', input: event.data.input as Record<string, unknown>, time: { start: event.created } }
        return emitPart(part)
      }
      case 'session.tool.progress': {
        const part = this.tools.get(event.data.id)
        if (!part || part.state.status !== 'running') return []
        part.state = { ...part.state, metadata: event.data.metadata }
        return emitPart(part)
      }
      case 'session.tool.success':
      case 'session.tool.failed': {
        const data = event.data
        const part = this.tools.get(data.id)
        if (!part) return []
        const input = part.state.input
        const time = { start: 'time' in part.state ? part.state.time.start : event.created, end: event.created }
        if (event.type === 'session.tool.success') {
          part.state = {
            status: 'completed', input, time, title: part.tool,
            output: event.data.content.map((entry) => entry.type === 'text' ? entry.text : entry.uri).join('\n'),
            metadata: data.metadata,
          }
        } else {
          part.state = { status: 'error', input, time, error: event.data.error.message, metadata: data.metadata }
        }
        return emitPart(part)
      }
      case 'session.step.ended': {
        const data = event.data
        return [
          { type: 'message.updated', properties: { info: { id: data.assistantMessageID, sessionID: data.sessionID, role: 'assistant', finish: data.finish, tokens: data.tokens, cost: data.cost } } },
          ...emitPart({ id: `${data.assistantMessageID}-finish`, sessionID: data.sessionID, messageID: data.assistantMessageID, type: 'step-finish', reason: data.finish, tokens: data.tokens, cost: data.cost }),
        ]
      }
      case 'session.step.failed':
      case 'session.compaction.failed':
        return [{ type: 'session.error', properties: { sessionID: event.data.sessionID, error: { name: event.data.error.type, data: { message: event.data.error.message } } } }]
      case 'session.execution.failed':
        return [
          { type: 'session.error', properties: { sessionID: event.data.sessionID, error: { name: event.data.error.type, data: { message: event.data.error.message } } } },
          { type: 'session.idle', properties: { sessionID: event.data.sessionID } },
        ]
      case 'session.compaction.ended':
        return [{ type: 'session.compacted', properties: { sessionID: event.data.sessionID } }]
      case 'session.status':
        return [{ type: 'session.status', properties: event.data }]
      case 'session.idle':
      case 'session.execution.succeeded':
      case 'session.execution.interrupted':
        return [{ type: 'session.idle', properties: event.data }]
      case 'permission.asked': {
        const data = event.data
        return [{ type: 'permission.asked', properties: {
          id: data.id, sessionID: data.sessionID, permission: data.action,
          patterns: data.resources, always: data.save ?? [], metadata: data.metadata ?? {},
          ...(data.source ? { tool: { messageID: data.source.messageID, callID: data.source.id } } : {}),
        } }]
      }
      default:
        return []
    }
  }
}
