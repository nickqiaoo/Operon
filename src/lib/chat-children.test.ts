import { describe, expect, it } from 'vitest'
import type { ExternalAgentView } from '@shared/external-agent'
import type { PendingInputSummary } from '@shared/pending-input'
import { buildChatChildren, childCounts } from './chat-children'

const PARENT = 7

function ext(childChatId: number, patch: Partial<ExternalAgentView> = {}): ExternalAgentView {
  return {
    agentId: `ext-${childChatId}`,
    parentChatId: PARENT,
    description: `agent ${childChatId}`,
    model: 'default',
    childChatId,
    providerId: 'codex',
    status: 'running',
    updatedAt: childChatId,
    ...patch,
  }
}

const approval = { approvalId: 'a1', toolName: 'Bash', inputPreview: 'rm -rf dist' } as PendingInputSummary
const none = new Map<number, PendingInputSummary[]>()

describe('buildChatChildren', () => {
  it('keeps only this chat’s external agents, and none of the assistant’s', () => {
    const children = buildChatChildren({
      chatId: PARENT,
      externalAgents: [ext(1), ext(2, { parentChatId: 99 }), ext(3, { parentChatId: 0, assistantActivityId: 'act' })],
      pendingByChat: none,
    })
    expect(children.map((c) => c.key)).toEqual(['ext-1'])
  })

  it('marks an agent with pending input as needing you, whatever its turn says', () => {
    const [child] = buildChatChildren({ chatId: PARENT, externalAgents: [ext(1)], pendingByChat: new Map([[1, [approval]]]) })
    expect(child.state).toBe('needs-you')
    expect(child.pending).toEqual([approval])
  })

  it('maps turn states and sorts by state, then newest first', () => {
    const children = buildChatChildren({
      chatId: PARENT,
      externalAgents: [
        ext(1, { status: 'queued' }),
        ext(2, { status: 'completed' }),
        ext(3, { status: 'failed', error: 'boom' }),
        ext(4, { status: 'interrupted' }),
        ext(5, { status: 'idle' }),
        ext(6),
      ],
      pendingByChat: new Map([[6, [approval]]]),
    })
    expect(children.map((c) => [c.key, c.state, c.detail])).toEqual([
      ['ext-6', 'needs-you', undefined],
      ['ext-3', 'failed', 'boom'],
      ['ext-1', 'running', undefined],
      ['ext-5', 'done', undefined],
      ['ext-2', 'done', undefined],
      ['ext-4', 'stopped', undefined],
    ])
    expect(childCounts(children)).toEqual({ total: 6, needsYou: 1, failed: 1, running: 1, finished: 3 })
  })
})
