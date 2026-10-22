import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MobileSpecChatsList } from './MobileSpecChatsList'

const { view } = vi.hoisted(() => ({ view: vi.fn() }))
vi.mock('@/components/spec/spec-shared', () => ({ useSpecView: view }))
vi.mock('@/components/icons/AgentAvatar', () => ({ AgentAvatar: () => null }))

const chat = (chatId: number, workspaceId: number | null) => ({
  chatId, title: `Conversation ${chatId}`, providerId: 'codex', workspaceId,
  subAgent: true, updatedAt: 0,
})

describe('mobile Spec conversations', () => {
  it('shows the complete cross-workspace list, including finished tickets, without the sidebar preview limit', () => {
    view.mockReturnValue({ spec: {
      sourceChat: chat(1, 1), coordinator: null,
      agents: Array.from({ length: 7 }, (_, index) => ({
        runId: 'run', index, phase: 'Build', state: index === 0 ? 'running' : 'done',
        chats: [chat(index + 2, index + 10)],
      })),
      tickets: null,
      ticketTasks: { T1: { number: 10, chats: [chat(9, null), chat(2, 10)] } },
    }, error: null })
    const html = renderToStaticMarkup(<MobileSpecChatsList specId={10} onOpenChat={() => {}} />)
    expect(html.match(/<button /g)).toHaveLength(9)
    expect(html).toContain('Conversation 8')
    expect(html).toContain('#10 · Conversation 9')
    expect(html).toContain('aria-label="Running"')
    expect(html).not.toContain('Show more')
  })

  it('distinguishes loading, errors and an empty Spec', () => {
    const render = () => renderToStaticMarkup(<MobileSpecChatsList specId={10} onOpenChat={() => {}} />)
    view.mockReturnValue({ spec: null, error: null })
    expect(render()).toContain('Loading conversations…')
    view.mockReturnValue({ spec: null, error: 'offline' })
    expect(render()).toContain('Could not load conversations. Retrying…')
    view.mockReturnValue({ spec: { sourceChat: null, coordinator: null, agents: [], tickets: null, ticketTasks: {} }, error: null })
    expect(render()).toContain('No conversations yet.')
  })
})
