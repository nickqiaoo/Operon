import { describe, it, expect } from 'vitest'
import type { UIMessage } from 'ai'
import { matchExternalAgentRun, parseExternalAgentRun } from './useExternalAgent'
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

describe('parseExternalAgentRun with a Codex MCP wrapper', () => {
  it('reads the run inside { server, tool, status, result }', () => {
    const inner = { task_id: 't1', agent_id: 'ext-20', chat_id: 20, agent_type: 'opencode', description: 'Plan', model: 'default', status: 'running' }
    const part = {
      type: 'dynamic-tool',
      toolName: 'mcp__external_agent__external_agent_run',
      state: 'output-available',
      output: { server: 'external_agent', tool: 'external_agent_run', status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(inner) }] } },
    } as unknown as Parameters<typeof parseExternalAgentRun>[0]
    expect(parseExternalAgentRun(part)).toMatchObject({ taskId: 't1', agentId: 'ext-20', childChatId: 20, agentType: 'opencode' })
  })
})

describe('matchExternalAgentRun', () => {
  const agent = (childChatId: number, patch: Partial<{ parentChatId: number; providerId: string; description: string; assistantActivityId: string }> = {}) => ({
    agentId: `ext-${childChatId}`, parentChatId: 39, providerId: 'opencode', description: 'probe', childChatId, ...patch,
  })

  it('finds a code-mode run by its parent, agent type and title, newest first', () => {
    const agents = [agent(40), agent(41, { providerId: 'codex' }), agent(42, { parentChatId: 7 }), agent(38)]
    expect(matchExternalAgentRun(agents, 39, { agentType: 'opencode', description: 'probe' })).toBe('ext-40')
  })

  it('never matches the assistant’s agents, or without a parent or a title', () => {
    const agents = [agent(40, { parentChatId: 0, assistantActivityId: 'act' })]
    expect(matchExternalAgentRun(agents, 0, { agentType: 'opencode', description: 'probe' })).toBeUndefined()
    expect(matchExternalAgentRun([agent(40)], undefined, { description: 'probe' })).toBeUndefined()
    expect(matchExternalAgentRun([agent(40)], 39, { agentType: 'opencode' })).toBeUndefined()
  })
})
