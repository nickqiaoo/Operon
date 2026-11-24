import type { UIMessage } from 'ai'

/**
 * The message a parent conversation receives when one of its external agents
 * finishes a turn — the same for an agent on this machine and one on another.
 */
export interface ExternalAgentResultFields {
  agentId: string
  providerId: string
  description: string
  childChatId: number
  /** The machine the agent's conversation lives on, when it is not this one. */
  machine?: string
  turnId: string
  status: string
  error?: string
  dispatched: boolean
  prompt: string
  result: string
  /** Set when the agent works in a workspace of its own. */
  workspace?: { id: number; branch: string; worktreePath: string }
}

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export function externalAgentResultMessage(fields: ExternalAgentResultFields, messageId: string): UIMessage {
  const { dispatched, workspace } = fields
  const source = dispatched ? 'parent agent' : 'user in child chat'
  const where = workspace
    ? `<workspace-id>${workspace.id}</workspace-id>\n<branch>${escape(workspace.branch)}</branch>\n<worktree-path>${escape(workspace.worktreePath)}</worktree-path>\n`
    : ''
  const machine = fields.machine ? `<machine>${escape(fields.machine)}</machine>\n` : ''
  const text = `[External Agent Result]\n<external-agent-result>
<task-id>${fields.turnId}</task-id>
<agent-id>${fields.agentId}</agent-id>
<agent-type>${escape(fields.providerId)}</agent-type>
<description>${escape(fields.description)}</description>
<child-chat-id>chat:${fields.childChatId}</child-chat-id>
<db-chat-id>${fields.childChatId}</db-chat-id>
${machine}<status>${fields.status}</status>
${where}<prompt-source>${source}</prompt-source>
<prompt>${escape(fields.prompt.slice(0, 8_000))}</prompt>
<result>${escape(fields.status === 'completed' ? fields.result : fields.error ?? fields.status)}</result>
</external-agent-result>
${!dispatched ? 'The user is talking to this agent directly; this is for your information. Do not act on it unless the user asks. No reply is needed: end your turn without saying anything.' : fields.status === 'cancelled' ? 'The user stopped this turn. Do not restart it automatically; wait for further instructions.' : 'Use this result to continue. If the agent is asking the user something, tell the user the question and that they can answer in the agent\'s tab, then end your turn. Do not answer it on the user\'s behalf or send the agent a reply the user did not give. To follow up with this same agent, call external_agent_send with its agent_id.'}`
  return { id: messageId, role: 'user', parts: [{ type: 'text', text }], metadata: { externalAgentResult: {
    agentId: fields.agentId, turnId: fields.turnId, childChatId: fields.childChatId, status: fields.status,
  } } }
}
