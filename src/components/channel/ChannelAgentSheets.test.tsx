// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { IntlProvider } from 'react-intl'
import { afterEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useChannelStore } from '@/stores/channel-store'
import { api } from '@/lib/api'
import { AgentManageDialog } from './AgentManageDialog'
import { MemberManageDialog } from './MemberManageDialog'
import type { ReactNode } from 'react'

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobileShell: () => true }))
const agent = { id: 1, name: 'Scout', provider: 'codex', model: 'test', permissionMode: '', instructions: '', thinkingLevel: '', env: [], canDelegate: false, createdAt: 0 }
const channel = { id: 4, name: 'design', description: '', projectId: 1, createdAt: 0 }
const currentMember = { id: 5, channelId: 4, agentId: 1, joinedAt: 0 }

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
let root: ReturnType<typeof createRoot>
async function renderSheet(content: ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }))
  root = createRoot(document.createElement('div'))
  await act(async () => root.render(<QueryClientProvider client={client}><IntlProvider locale="en">{content}</IntlProvider></QueryClientProvider>))
}

afterEach(async () => {
  await act(async () => root?.unmount())
  client.clear()
  useChannelStore.setState(useChannelStore.getInitialState())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('opens the agent editor from the mobile management sheet and saves the selected agent', async () => {
  vi.spyOn(api, 'agentListSessions').mockResolvedValue({ sessions: [] })
  const updateAgent = vi.fn().mockResolvedValue(undefined)
  useChannelStore.setState({ agents: [agent], updateAgent })
  vi.spyOn(api, 'getProviderModels').mockResolvedValue({})
  await renderSheet(<AgentManageDialog open onClose={vi.fn()} providers={[{ id: 'codex', label: 'Codex' }]} />)
  const edit = document.querySelector<HTMLButtonElement>('[data-slot=mobile-sheet-body] button[title=Edit]')
  expect(edit).toBeTruthy()
  await act(async () => edit!.click())
  const name = document.querySelector<HTMLInputElement>('input[placeholder="e.g. architect"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Editor')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const save = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save Changes')
  expect(save).toBeTruthy()
  await act(async () => save!.click())
  expect(updateAgent).toHaveBeenCalledWith(agent.id, expect.objectContaining({ name: 'Editor', model: agent.model }))
})

it('keeps the invited agent selected across a membership refresh and adds only that agent', async () => {
  const addMember = vi.fn().mockResolvedValue(undefined)
  const removeMember = vi.fn()
  useChannelStore.setState({
    agents: [agent, { ...agent, id: 2, name: 'Writer' }], members: { 4: [currentMember] },
    loadMembers: vi.fn().mockResolvedValue(undefined), addMember, removeMember,
  })
  await renderSheet(<MemberManageDialog channel={channel} onClose={vi.fn()} />)
  const choices = document.querySelectorAll<HTMLButtonElement>('[data-slot=mobile-sheet-body] button[aria-pressed]')
  expect(choices[0].getAttribute('aria-pressed')).toBe('true')
  await act(async () => choices[1].click())
  await act(async () => { useChannelStore.setState({ members: { 4: [{ ...currentMember }] } }) })
  const done = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Done')
  await act(async () => done!.click())
  expect(addMember).toHaveBeenCalledWith(channel.id, 2)
  expect(removeMember).not.toHaveBeenCalled()
})
