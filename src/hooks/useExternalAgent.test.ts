import { describe, it, expect } from 'vitest'
import type { UIMessage } from 'ai'
import { parseExternalAgentRun } from './useExternalAgent'
import { parseExternalAgentResult } from '@/components/editor/components/ExternalAgentRenderer'

describe('ExternalAgent chat links', () => {
  it('recovers a durable child link from both run and follow-up tool results without executing anything', () => {
    for (const toolName of ['mcp__external_agent__external_agent_run', 'mcp__external_agent__external_agent_send']) {
      const part = { type: 'dynamic-tool', toolName, toolCallId: 'call', state: 'output-available', input: {},
        output: { content: [{ type: 'text', text: JSON.stringify({
          agent_id: 'ext-17', task_id: 'turn-2', chat_id: 17, agent_type: 'codex', status: 'queued',
        }) }] } } as UIMessage['parts'][number]
      expect(parseExternalAgentRun(part)).toMatchObject({ agentId: 'ext-17', taskId: 'turn-2', childChatId: 17 })
    }
  })
  it('keeps cancellation separate from successful results and retains the parent-facing agent id', () => {
    expect(parseExternalAgentResult(`<external-agent-result><task-id>turn-1</task-id><agent-id>ext-17</agent-id><agent-type>codex</agent-type><description>Review</description><child-chat-id>chat:17</child-chat-id><db-chat-id>17</db-chat-id><status>cancelled</status></external-agent-result>`))
      .toMatchObject({ agentId: 'ext-17', dbChatId: 17, status: 'cancelled' })
  })
})
