import type { SpecChatRef, SpecView } from '@shared/spec'

interface SessionEntry {
  key: string
  label: string
  state?: string
  phase?: string
  chat: SpecChatRef
}

interface SessionPhase {
  title: string
  rows: SessionEntry[]
}

/** Keep ticket implementations with their reviews in Build, before the whole-change Review. */
export function groupSpecSessions(spec: Pick<SpecView, 'agents' | 'tickets' | 'ticketTasks'>) {
  const phases: SessionPhase[] = []
  const byChat = new Map<number, SessionEntry>()
  let earlier = 0
  for (const agent of spec.agents) {
    if (!agent.chats?.length) {
      earlier++
      continue
    }
    const title = agent.phase ?? ''
    let group = phases.at(-1)
    if (!group || group.title !== title) phases.push((group = { title, rows: [] }))
    for (const chat of agent.chats) {
      if (byChat.has(chat.chatId)) continue
      const row = { key: String(chat.chatId), label: chat.title, state: agent.state, chat }
      group.rows.push(row)
      byChat.set(chat.chatId, row)
    }
  }
  for (const [key, task] of Object.entries(spec.ticketTasks)) {
    const ticket = spec.tickets?.find((ticket) => ticket.key === key)
    for (const chat of task.chats) {
      const label = ticket ? `${ticket.key} · ${ticket.title}` : `#${task.number} · ${chat.title}`
      const existing = byChat.get(chat.chatId)
      if (existing) {
        existing.label = label
        continue
      }
      let build = phases.find((p) => p.title === 'Build')
      if (!build) {
        build = { title: 'Build', rows: [] }
        const review = phases.findIndex((p) => p.title === 'Review')
        phases.splice(review < 0 ? phases.length : review, 0, build)
      }
      const row = { key: String(chat.chatId), label, chat }
      build.rows.push(row)
      byChat.set(chat.chatId, row)
    }
  }
  // Chat ids follow creation order; updatedAt would move an old conversation
  // whenever someone opens it again and sends another message.
  for (const phase of phases) {
    if (phase.title === 'Build') phase.rows.sort((a, b) => a.chat.chatId - b.chat.chatId)
  }
  return { phases: phases.filter((p) => p.rows.length > 0), earlier }
}

/** The same complete, unique conversation list for the task page and sidebar. */
export function listSpecSessions(spec: Pick<SpecView, 'sourceChat' | 'coordinator' | 'agents' | 'tickets' | 'ticketTasks'>): SessionEntry[] {
  const rows: SessionEntry[] = []
  if (spec.sourceChat) rows.push({ key: String(spec.sourceChat.chatId), label: spec.sourceChat.title, chat: spec.sourceChat })
  if (spec.coordinator?.chat) rows.push({
    key: String(spec.coordinator.chat.chatId), label: 'Coordinator',
    state: spec.coordinator.status === 'active' ? 'running' : undefined, chat: spec.coordinator.chat,
  })
  rows.push(...groupSpecSessions(spec).phases.flatMap((phase) => phase.rows.map((row) => ({ ...row, phase: phase.title }))))
  const seen = new Set<number>()
  return rows.filter(({ chat }) => {
    if (seen.has(chat.chatId)) return false
    seen.add(chat.chatId)
    return true
  })
}
