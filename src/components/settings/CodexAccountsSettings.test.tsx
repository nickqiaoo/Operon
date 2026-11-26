// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IntlProvider } from 'react-intl'
import zhCN from '@/i18n/locales/zh-CN.json'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { CodexAccountsView } from '@operon/agent-runtime/codex'
import { CodexAccountsSettings } from './CodexAccountsSettings'
import { api } from '@/lib/api'
import { openExternalUrl } from '@/lib/open-external'

vi.mock('@/lib/api', () => ({ api: {
  codexAccounts: vi.fn(), codexAccountLogin: vi.fn(), codexAccountSelect: vi.fn(), codexWorkspaceSelect: vi.fn(), codexAccountReset: vi.fn(),
} }))
vi.mock('@/lib/open-external', () => ({ openExternalUrl: vi.fn() }))

it.each(['en', 'zh-CN'])('selects and signs in using the %s settings', async locale => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const data: CodexAccountsView = {
    accounts: ['a', 'b'].map(id => ({ id, email: id + '@example.test', plan: 'plus', signedIn: true, quota: null })),
    current: 'a', automatic: true, login: null, message: null,
  }
  vi.mocked(api.codexAccounts).mockImplementation(async () => ({ ...data }))
  vi.mocked(api.codexAccountSelect).mockImplementation(async id => { data.current = id })
  vi.mocked(api.codexAccountLogin).mockImplementation(async () => {
    data.login = { url: 'https://example.invalid/device', code: 'EXAMPLE' }
    return data.login
  })
  const c = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const container = document.createElement('div')
  const root = createRoot(container)
  const click = (name: string) => {
    const scope = document.querySelector('[role="dialog"]') ?? container
      const button = [...scope.querySelectorAll('button')].find(b => b.textContent?.trim() === name)
    expect(button).toBeDefined()
    button!.click()
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))
  try {
    await act(async () => { root.render(<QueryClientProvider client={c}><IntlProvider locale={locale} messages={locale === 'zh-CN' ? zhCN : {}}><CodexAccountsSettings /></IntlProvider></QueryClientProvider>) })
    await act(settle)
    await act(async () => { click(locale === 'en' ? 'Use account' : '使用此账号'); await settle() })
    expect(api.codexAccountSelect).toHaveBeenCalledWith('b')
    await act(async () => { click(locale === 'en' ? 'Add account' : '添加账号'); await settle() })
    expect(api.codexAccountLogin).toHaveBeenCalledWith(true, undefined)
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.invalid/device')
    expect(container.textContent).toContain('EXAMPLE')
  } finally {
    await act(async () => root.unmount())
    c.clear()
  }
})


it.each(['success', 'failure'])('shows the pending workspace and settles on %s', async outcome => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  let active = 'personal'
  let finish!: () => void
  vi.mocked(api.codexWorkspaceSelect).mockImplementation(() => new Promise((resolve, reject) => {
    finish = () => {
      if (outcome === 'failure') return reject(new Error('Switch failed'))
      active = 'team'
      resolve(undefined)
    }
  }))
  vi.mocked(api.codexAccounts).mockImplementation(async () => ({
    current: 'a', automatic: true, login: null, message: null,
    accounts: [{ id: 'a', email: null, signedIn: true, quota: null, plan: null, workspaceId: active,
      workspaces: [{ accountId: 'personal', name: 'Personal', kind: 'personal' }, { accountId: 'team', name: 'Team', kind: 'workspace' }] }],
  }))
  const client = new QueryClient()
  const container = document.createElement('div')
  const root = createRoot(container)
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><IntlProvider locale="en"><CodexAccountsSettings /></IntlProvider></QueryClientProvider>))
    await act(settle)
    const select = container.querySelector('select')!
    await act(async () => {
      select.value = 'team'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await settle()
    })
    expect(select.value).toBe('team')
    expect(select.disabled).toBe(true)
    expect(select.parentElement?.querySelector('[role=status]')?.textContent).toContain('Switching')
    await act(async () => { finish(); await settle() })
    expect(select.disabled).toBe(false)
    expect(select.value).toBe(active)
    expect(select.parentElement?.querySelector('[role=status]')).toBeNull()
    if (outcome === 'failure') expect(container.querySelector('[role=alert]')?.textContent).toBe('Switch failed')
  } finally {
    await act(async () => root.unmount())
    client.clear()
  }
})


it('confirms count-only resets and reuses the attempt key after a failed request', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const account = { id: 'b', email: 'b@example.test', plan: 'plus', signedIn: true, quota: null,
    resetCredits: { availableCount: 1, credits: null } }
  vi.mocked(api.codexAccounts).mockImplementation(async () => ({
    accounts: [account], current: 'a', automatic: true, login: null, message: null,
  }))
  const reset = vi.mocked(api.codexAccountReset).mockRejectedValueOnce(new Error('Disconnected'))
    .mockImplementationOnce(async () => { account.resetCredits.availableCount = 0; return { outcome: 'reset' } })
  const client = new QueryClient()
  const container = document.createElement('div')
  const root = createRoot(container)
  const settle = () => new Promise(resolve => setTimeout(resolve, 25))
  async function clickReset() {
    await act(async () => {
      const scope = document.querySelector('[role="dialog"]') ?? container
      const button = [...scope.querySelectorAll('button')].find(b => b.textContent === 'Use reset')
      expect(button).toBeDefined()
      button!.click()
      await settle()
    })
  }
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><IntlProvider locale="en"><CodexAccountsSettings /></IntlProvider></QueryClientProvider>))
    await act(settle)
    await clickReset()
    expect(document.body.textContent).toContain('Use one reset for b@example.test?')
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"] [data-slot="dialog-title"]'))
    expect(reset).not.toHaveBeenCalled()
    await clickReset()
    expect(document.body.textContent).toContain('Disconnected')
    await clickReset()
    expect(reset.mock.calls[1]).toEqual(reset.mock.calls[0])
    expect(container.textContent).toContain('Usage reset.')
    expect(container.textContent).not.toContain('Use reset')
  } finally {
    await act(async () => root.unmount())
    client.clear()
  }
})
