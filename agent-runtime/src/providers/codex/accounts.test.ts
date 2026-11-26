import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeContext } from '../../context.js'
import { CodexAccounts } from './accounts.js'
import { AppServerClient } from './sdk/app-server-client.js'
import { disposeAllAppServerClients } from './sdk/client-registry.js'
import type { AccountRateLimitSnapshot } from './sdk/protocol/index.js'

describe('Codex account rotation', () => {
  let base: string
  let accounts: CodexAccounts
  let loginClient: AppServerClient
  let selected: Map<string, string>
  let partialLists: number
  let loginUser: string
  let identity: Map<string, string>
  let plans: Map<string, string>
  let limits: Map<string, [number, number]>
  const home = (client: AppServerClient) => (client as unknown as { settings: { env: { CODEX_HOME: string } } }).settings.env.CODEX_HOME
  const push = (client: AppServerClient, method: string, params: unknown) =>
    (client as unknown as { handleMessage(m: unknown): void }).handleMessage({ method, params })

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'operon-account-'))
    accounts = new CodexAccounts(createRuntimeContext({ env: () => ({ CODEX_HOME: base }) }))
    identity = new Map([[base, 'A']])
    limits = new Map()
    plans = new Map()
    partialLists = 0
    selected = new Map()
    vi.spyOn(AppServerClient.prototype, 'request').mockImplementation(async function (this: AppServerClient, method, params) {
      const path = home(this)
      if (method === 'account/login/start') {
        loginClient = this
        identity.set(path, loginUser)
        return { authUrl: 'https://example.invalid/sign-in', loginId: 'login' }
      }
      if (method === 'accountSession/list' || method === 'accountSession/switch') {
        if (method === 'accountSession/switch') selected.set(path, (params as { accountId: string }).accountId)
        return { activeSessionId: 'login', sessions: [{ sessionId: 'login', selectedWorkspaceAccountId: selected.get(path),
          workspaces: method === 'accountSession/switch' || partialLists-- > 0
            ? [{ accountId: selected.get(path), kind: null, name: null }]
            : [{ accountId: 'personal', kind: 'personal', name: null }, { accountId: 'team', kind: 'workspace', name: 'Team' }] }] }
      }
      if (method !== 'account/read') throw new Error('Unexpected method ' + method)
      const userId = identity.get(path)
      return { userId, workspaceRouting: { chatgptAccountId: selected.get(path) }, account: userId ? { type: 'chatgpt', email: userId + '@example.test' } : null }
    })
    vi.spyOn(AppServerClient.prototype, 'readRateLimits').mockImplementation(async function (this: AppServerClient) {
      const [short, long] = limits.get(home(this) + ':' + selected.get(home(this))) ?? limits.get(home(this)) ?? [0, 0]
      const window = (usedPercent: number, windowDurationMins: number) => ({
        usedPercent, windowDurationMins, resetsAt: Math.ceil(Date.now() / 1000) + 3600,
      })
      const quota: AccountRateLimitSnapshot = { limitId: 'codex', limitName: null, primary: window(short, 300), secondary: window(long, 10080), credits: null, planType: plans.get(home(this) + ':' + selected.get(home(this))) ?? null }
      return { rateLimitsByLimitId: { codex: quota } }
    })
  })
  afterEach(() => {
    accounts.dispose()
    disposeAllAppServerClients()
    vi.restoreAllMocks()
    rmSync(base, { recursive: true, force: true })
  })

  async function login(user: string) {
    loginUser = user
    await accounts.startLogin(false)
    push(loginClient, 'account/login/completed', { loginId: 'login', success: true })
    await vi.waitFor(async () => expect((await accounts.getState()).login).toBeNull())
    return home(loginClient)
  }

  it('redeems on the selected row and rejects a stale workspace', async () => {
    const path = await login('B')
    const target = (await accounts.getState()).accounts[1]
    const original = vi.mocked(AppServerClient.prototype.request).getMockImplementation()!
    const calls: string[] = []
    vi.mocked(AppServerClient.prototype.request).mockImplementation(async function (this: AppServerClient, method, params, ...rest) {
      if (method !== 'account/rateLimitResetCredit/consume') return original.call(this, method, params, ...rest)
      calls.push(home(this))
      expect(params).toEqual({ idempotencyKey: 'attempt', creditId: 'card' })
      return { outcome: 'reset' }
    })
    const identity = { email: target.email, workspaceId: null }
    const request = { accountId: target.id, expectedIdentity: identity, idempotencyKey: 'attempt', creditId: 'card' }
    await expect(accounts.redeemReset(request)).resolves.toEqual({ outcome: 'reset' })
    selected.set(path, 'team')
    await expect(accounts.redeemReset(request)).rejects.toThrow('workspace changed')
    expect(calls).toEqual([path])
    expect((await accounts.getState()).current).toBe('default')
  })

  it('uses official login, shares sessions, preserves selection and rejects a duplicate', async () => {
    const b = await login('B')
    expect(realpathSync(join(b, 'sessions'))).toBe(realpathSync(join(base, 'sessions')))
    await login('B')
    const view = await accounts.getState()
    expect(view.accounts.map(a => a.email)).toEqual(['A@example.test', 'B@example.test'])
    expect(view.current).toBe('default')
    expect(view.message).toContain('already added')
  })

  it('waits for existing turns, skips either exhausted window, and resumes admissions on one account', async () => {
    const b = await login('B')
    await login('C')
    const running = await accounts.enterTurn()
    limits.set(base, [100, 10])
    limits.set(b, [20, 100])
    const target = (await accounts.getState(true)).accounts[2].id
    const admission = accounts.enterTurn()
    const second = accounts.enterTurn()
    expect(accounts.generation).toBe(0)
    running()
    const releases = await Promise.all([admission, second])
    expect((await accounts.getState()).current).toBe(target)
    expect(accounts.generation).toBe(1)
    releases.forEach(release => release())
    expect((await new CodexAccounts(createRuntimeContext({ env: () => ({ CODEX_HOME: base }) })).getState()).current).toBe(target)
  })

  it('never rotates on a transient rate limit and never retries an exhausted turn', async () => {
    await login('B')
    const lease = accounts.acquire()
    accounts.observeUsage(lease)
    const notify = (code: string) => push(lease.client, 'turn/completed', { turn: { error: { codexErrorInfo: code } } })
    notify('rateLimitExceeded')
    ;(await accounts.enterTurn())()
    expect((await accounts.getState()).current).toBe('default')
    const release = await accounts.enterTurn()
    notify('usageLimitExceeded')
    notify('usageLimitExceeded')
    release()
    ;(await accounts.enterTurn())()
    expect(accounts.generation).toBe(1)
    lease.release()
  })

  it('drains a background thread after the parent finishes', async () => {
    await login('B')
    const target = (await accounts.getState()).accounts[1].id
    const lease = accounts.acquire()
    push(lease.client, 'turn/started', { threadId: 'child' })
    const switching = accounts.select(target)
    const next = accounts.enterTurn()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((await accounts.getState()).current).toBe('default')
    push(lease.client, 'turn/completed', { threadId: 'child' })
    await switching
    ;(await next)()
    expect((await accounts.getState()).current).toBe(target)
    lease.release()
  })

  it('exhausts the current login’s workspaces before moving to another login', async () => {
    selected.set(base, 'personal')
    const changes = vi.fn()
    accounts.subscribeSelection(changes)
    limits.set(base + ':personal', [100, 20])
    limits.set(base + ':team', [1, 5])
    await accounts.getState(true)
    ;(await accounts.enterTurn())()
    const team = await accounts.getState()
    expect(team.current).toBe('default')
    expect(team.accounts[0].workspaceId).toBe('team')
    expect(team.accounts[0].quota?.primary?.usedPercent).toBe(1)
    expect(changes).toHaveBeenCalledTimes(2)
    await login('B')
    limits.set(base + ':team', [1, 100])
    await accounts.getState(true)
    ;(await accounts.enterTurn())()
    expect((await accounts.getState()).current).not.toBe('default')
    expect(changes).toHaveBeenCalledTimes(3)
  })

  it.each(['free', 'unknown', 'plus'])('rotates from team with a %s personal space', async plan => {
    selected.set(base, 'personal')
    plans.set(base + ':personal', plan)
    await accounts.getState(true)
    await accounts.select('default', 'team')
    await login('B')
    limits.set(base + ':team', [100, 0])
    await accounts.getState(true)
    ;(await accounts.enterTurn())()
    const view = await accounts.getState()
    expect(view.accounts[0].workspaceId).toBe(plan === 'plus' ? 'personal' : 'team')
    expect(view.current).toBe(plan === 'plus' ? 'default' : view.accounts[1].id)
  })

  it('recovers cold metadata and keeps both choices through a partial refresh and switch back', async () => {
    selected.set(base, 'personal')
    partialLists = 1
    expect((await accounts.getState()).accounts[0].workspaces).toHaveLength(2)
    await accounts.select('default', 'team')
    partialLists = 2
    expect((await accounts.getState(true)).accounts[0].workspaces).toHaveLength(2)
    await accounts.select('default', 'personal')
    expect((await accounts.getState()).accounts[0].workspaceId).toBe('personal')
  })

  it('manually selects a workspace and waits for running turns', async () => {
    selected.set(base, 'personal')
    await accounts.getState()
    const release = await accounts.enterTurn()
    const switchToTeam = accounts.select('default', 'team')
    expect(selected.get(base)).toBe('personal')
    release()
    await switchToTeam
    expect((await accounts.getState()).accounts[0].workspaceId).toBe('team')
    expect((await accounts.getState()).accounts[0].workspaces?.map(w => w.accountId)).toEqual(['personal', 'team'])
    await accounts.select('default', 'personal')
    expect((await accounts.getState()).accounts[0].workspaceId).toBe('personal')
    await expect(accounts.select('default', 'missing')).rejects.toThrow('Unknown Codex workspace')
  })

  it('honors manual mode and reports exhaustion of all accounts without switching', async () => {
    const b = await login('B')
    limits.set(base, [0, 100])
    limits.set(b, [100, 0])
    await accounts.getState(true)
    await expect(accounts.enterTurn()).rejects.toThrow('Next reset')
    accounts.setAutomatic(false)
    ;(await accounts.enterTurn())()
    expect((await accounts.getState()).current).toBe('default')
  })
})
