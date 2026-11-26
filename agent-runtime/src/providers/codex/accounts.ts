import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RuntimeContext } from '../../context.js'
import { acquireAppServerClient, retireAppServerClient, type AppServerLease } from './sdk/client-registry.js'
import type { CodexAppServerSettings } from './sdk/types/index.js'
import type { AccountRateLimitSnapshot, AccountRateLimitsReadResult, CodexResetOutcome } from './sdk/protocol/index.js'

type Identity = { account: { type: string; email?: string; planType?: string } | null; userId?: string; workspaceRouting?: { chatgptAccountId?: string } | null }
const accountId = z.union([z.literal('default'), z.string().uuid()])
const configuration = z.object({ ids: z.array(accountId), current: accountId, automatic: z.boolean() })
  .refine(c => c.ids.includes('default') && c.ids.includes(c.current))
type Configuration = z.infer<typeof configuration>
interface Workspace { accountId: string; name: string | null; kind: 'personal' | 'workspace' | null }
interface Memberships { activeSessionId: string | null; sessions: { sessionId: string; selectedWorkspaceAccountId: string | null; workspaces: Workspace[] }[] }
interface AccountInfo { resetCredits?: AccountRateLimitsReadResult['rateLimitResetCredits']; workspaceId?: string; workspaces?: Workspace[]; id: string; email: string | null; plan: string | null; signedIn: boolean; quota: AccountRateLimitSnapshot | null }
interface Login { url: string; code?: string }
export interface CodexAccountsView {
  accounts: AccountInfo[]
  current: string
  automatic: boolean
  login: Login | null
  message: string | null
  notice?: { type: 'switched'; email: string | null; minutes: number | null } | { type: 'unavailable'; resetAt: number | null }
}
const DEFAULT = 'default'
const initial = (): Configuration => ({ ids: [DEFAULT], current: DEFAULT, automatic: true })

export function exhausted(quota: AccountRateLimitSnapshot | null, now = Date.now()) {
  return [quota?.primary, quota?.secondary].some(w => w && w.usedPercent >= 100 && (!w.resetsAt || w.resetsAt * 1000 > now))
}

export class CodexAccounts {
  private readonly base: string
  private readonly directory: string
  private config: Configuration
  private cache = new Map<string, { at: number; info: AccountInfo; identity: Identity }>()
  private pending?: { id: string; lease: AppServerLease; login?: Login; unsubscribe?: () => void; timer: ReturnType<typeof setTimeout> }
  private notice: CodexAccountsView['notice']
  private message: string | null = null
  private queue = Promise.resolve()
  private turns = 0
  private drained?: () => void
  private errors = new Map<string, number>()
  private reads = new Map<string, Promise<AccountInfo>>()
  generation = 0
  private readonly listeners = new Set<(revision: string) => void>()
  private revision = randomUUID()
  subscribeSelection(listener: (revision: string) => void) {
    this.listeners.add(listener)
    listener(this.revision)
    return () => this.listeners.delete(listener)
  }
  private selectionChanged() {
    this.generation++
    this.revision = randomUUID()
    for (const listener of this.listeners) listener(this.revision)
  }

  private slot(id: string, workspace?: string) { return id + ':' + (workspace ?? '') }

  private workspacePlans = new Map<string, string>()
  private memberships = new Map<string, { at: number; session: Memberships['sessions'][number] }>()
  private async listWorkspaces(id: string, force = false) {
    const cached = this.memberships.get(id)
    if (!force && cached && Date.now() - cached.at < 60_000) return cached.session
    const lease = this.acquire({}, id)
    try {
      // Codex can acknowledge a metadata refresh with just the current ID.
      // A single named or typed workspace, on the other hand, is a valid list.
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await lease.client.request<Memberships>('accountSession/list', { refreshWorkspaceMetadata: true })
        const session = result.sessions.find(s => s.sessionId === result.activeSessionId)
        if (!session) return undefined
        const [only] = session.workspaces
        const partial = !only || (session.workspaces.length === 1 && !only.kind && !only.name)
        if (!partial) {
          this.memberships.set(id, { at: Date.now(), session })
          return session
        }
        if (cached?.session.sessionId === session.sessionId &&
            cached.session.workspaces.some(w => w.accountId === session.selectedWorkspaceAccountId)) {
          return { ...session, workspaces: cached.session.workspaces }
        }
      }
    } finally { lease.release() }
  }


  constructor(private ctx: RuntimeContext) {
    this.base = resolve(ctx.env().CODEX_HOME || join(homedir(), '.codex'))
    this.directory = join(this.base, 'operon-accounts')
    const path = join(this.directory, 'accounts.json')
    this.config = existsSync(path) ? configuration.parse(JSON.parse(readFileSync(path, 'utf8'))) : initial()
  }

  private save(config: Configuration) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const path = join(this.directory, 'accounts.json')
    const tmp = path + '.' + randomUUID()
    writeFileSync(tmp, JSON.stringify(config), { mode: 0o600 })
    renameSync(tmp, path)
    this.config = config
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action)
    this.queue = result.then(() => {}, () => {})
    return result
  }

  private key(id: string) { return id === DEFAULT ? 'local' : join(this.directory, id) }

  acquire(settings: CodexAppServerSettings = {}, id = this.config.current) {
    const managed = id !== DEFAULT
    return acquireAppServerClient({
      ...settings, codexPath: settings.codexPath ?? this.ctx.resolveBinary('codex'),
      env: { ...(settings.env ?? this.ctx.env()), ...(managed ? { CODEX_HOME: this.key(id) } : {}) },
      fileCredentials: managed,
    }, this.key(id))
  }

  private async inspect(id: string, force = false): Promise<AccountInfo> {
    const cached = this.cache.get(id)
    if (!force && cached && Date.now() - cached.at < 60_000) {
      const resetSinceRead = [cached.info.quota?.primary, cached.info.quota?.secondary].some(w =>
        w?.resetsAt && w.resetsAt * 1000 > cached.at && w.resetsAt * 1000 <= Date.now())
      if (!resetSinceRead) return cached.info
    }
    const existing = this.reads.get(id)
    if (existing) return existing
    const lease = this.acquire({}, id)
    const read = (async () => {
      const identity = await lease.client.request<Identity>('account/read', {})
      const limits = identity.account ? await lease.client.readRateLimits(0) : null
      const bucket = limits?.rateLimits
      const quota = limits?.rateLimitsByLimitId?.codex ?? (!bucket?.limitId || bucket.limitId === 'codex' ? bucket : null) ?? null
      const info = { id, resetCredits: limits?.rateLimitResetCredits, workspaceId: identity.workspaceRouting?.chatgptAccountId, signedIn: !!identity.account, email: identity.account?.email ?? null, plan: quota?.planType ?? identity.account?.planType ?? null, quota }
      if (info.workspaceId && info.plan) this.workspacePlans.set(this.slot(id, info.workspaceId), info.plan)
      this.cache.set(id, { at: Date.now(), info, identity })
      return info
    })().finally(() => { this.reads.delete(id); lease.release() })
    this.reads.set(id, read)
    return read
  }

  async getState(force = false): Promise<CodexAccountsView> {
    const accounts: AccountInfo[] = []
    for (const id of this.config.ids) {
      const info = await this.inspect(id, force)
      const session = info.workspaceId ? await this.listWorkspaces(id, force).catch(() => undefined) : undefined
      accounts.push({ ...info, workspaces: session?.workspaces })
    }
    return { accounts, current: this.config.current, automatic: this.config.automatic, login: this.pending?.login ?? null, message: this.message, notice: this.notice }
  }

  private async switchTo(id: string, automatic = false) {
    if (!this.config.ids.includes(id)) throw new Error('Unknown Codex account')
    const old = this.config.current
    if (id === old) return
    if (this.turns) await new Promise<void>(resolve => { this.drained = resolve })
    const lease = this.acquire({}, old)
    try {
      await lease.client.waitForIdle()
      if (automatic && !this.config.automatic) return false
      this.save({ ...this.config, current: id })
      const retired = retireAppServerClient(this.key(old))
      this.selectionChanged()
      await retired
      return true
    } finally { lease.release() }
  }

  private async switchWorkspace(id: string, session: Memberships['sessions'][number], workspaceId: string, automatic: boolean) {
    if (!session.workspaces.some(w => w.accountId === workspaceId)) throw new Error('Unknown Codex workspace')
    const lease = this.acquire({}, id)
    try {
      if (id === this.config.current && this.turns) await new Promise<void>(resolve => { this.drained = resolve })
      await lease.client.waitForIdle()
      if (automatic && !this.config.automatic) return null
      await this.reads.get(id)
      const changed = await lease.client.request<Memberships>('accountSession/switch', {
        sessionId: session.sessionId, accountId: workspaceId, allowBrowserLogin: false,
      })
      const selected = changed.sessions?.find(s => s.sessionId === changed.activeSessionId)
      if (selected?.selectedWorkspaceAccountId !== workspaceId) throw new Error('Codex did not confirm the workspace switch.')
      // The switch reply confirms the selection but may only describe that workspace.
      // Keep the choices from the metadata refresh for this session.
      this.memberships.set(id, { at: Date.now(), session: { ...session, selectedWorkspaceAccountId: workspaceId } })
      this.cache.delete(id)
      // Retire the old connection and its in-flight quota reads before publishing the selection.
      const retired = retireAppServerClient(this.key(id))
      if (id === this.config.current) this.selectionChanged()
      await retired
      const info = await this.inspect(id, true)
      if (info.workspaceId !== workspaceId) throw new Error('Codex did not confirm the workspace switch.')
      return info
    } finally { lease.release() }
  }

  select(id: string, workspaceId?: string) {
    return this.serial(async () => {
      if (!this.config.ids.includes(id) || !(await this.inspect(id)).signedIn) throw new Error('Sign in to this account first.')
      if (workspaceId && (await this.inspect(id)).workspaceId !== workspaceId) {
        const session = await this.listWorkspaces(id, true)
        if (!session) throw new Error('Unknown Codex workspace')
        await this.switchWorkspace(id, session, workspaceId, false)
      }
      await this.switchTo(id)
      this.notice = undefined
      this.message = null
    })
  }

  redeemReset({ accountId: id, expectedIdentity: target, idempotencyKey, creditId }: {
    accountId: string
    expectedIdentity: { email: string | null; workspaceId: string | null }
    idempotencyKey: string
    creditId?: string
  }) {
    return this.serial(async () => {
      if (!this.config.ids.includes(id)) throw new Error('Unknown Codex account')
      const lease = this.acquire({}, id)
      try {
        const identity = await lease.client.request<Identity>('account/read', {})
        if (!identity.account || (identity.account.email ?? null) !== target.email ||
            (identity.workspaceRouting?.chatgptAccountId ?? null) !== target.workspaceId) {
          throw new Error('Account or workspace changed. Refresh and try again.')
        }
        const result = await lease.client.request<{ outcome: CodexResetOutcome }>('account/rateLimitResetCredit/consume', {
          idempotencyKey, creditId,
        })
        await this.reads.get(id)?.catch(() => {})
        this.cache.delete(id)
        if (result.outcome === 'reset' || result.outcome === 'alreadyRedeemed') {
          this.errors.delete(this.slot(id, target.workspaceId ?? undefined))
          if (this.notice?.type === 'unavailable') {
            this.notice = undefined
            this.message = null
          }
        }
        return result
      } finally { lease.release() }
    })
  }

  setAutomatic(automatic: boolean) { this.save({ ...this.config, automatic }) }

  private async rotate() {
    if (!this.config.automatic) return
    if (this.config.ids.length === 1 && !this.ctx.resolveBinary('codex') && !this.cache.size) return
    const { current, ids } = this.config
    const blocked = (id: string, workspace?: string) => (this.errors.get(this.slot(id, workspace)) ?? 0) > Date.now()
    const active = await this.inspect(current).catch(() => null)
    // Failed reads alone never trigger a switch. A typed usage error does.
    if (!blocked(current, active?.workspaceId) && !exhausted(active?.quota ?? null)) return
    if (active) this.rememberExhaustion(active)
    const unavailable: AccountInfo[] = []
    const index = ids.indexOf(current)
    for (let offset = 0; offset < ids.length; offset++) {
      const id = ids[(index + offset) % ids.length]
      let candidate = offset === 0 ? active : await this.inspect(id).catch(() => null)
      if (!candidate?.signedIn || candidate.plan === 'free') continue
      if (!candidate.quota || exhausted(candidate.quota) || blocked(id, candidate.workspaceId)) {
        unavailable.push(candidate)
        const session = candidate.workspaceId ? await this.listWorkspaces(id).catch(() => undefined) : undefined
        const original = candidate.workspaceId
        candidate = null
        for (const ws of session?.workspaces ?? []) {
          if (!session || ws.accountId === original || blocked(id, ws.accountId)) continue
          const plan = this.workspacePlans.get(this.slot(id, ws.accountId))
          // Memberships do not include plans. Only try a personal space after
          // its own account/quota read has confirmed a paid subscription.
          if (plan === 'free' || (ws.kind !== 'workspace' && (!plan || plan === 'unknown'))) continue
          const next = await this.switchWorkspace(id, session, ws.accountId, true).catch(() => null)
          if (!this.config.automatic) return
          if (!next) continue
          if (next.plan !== 'free' && next.quota && !exhausted(next.quota)) { candidate = next; break }
          unavailable.push(next)
          this.rememberExhaustion(next)
        }
      }
      if (!candidate) continue
      if (id !== current && !await this.switchTo(id, true)) return
      const ws = this.memberships.get(id)?.session.workspaces.find(w => w.accountId === candidate.workspaceId)
      const label = [candidate.email, ws?.name ?? candidate.plan].filter(Boolean).join(' · ')
      const spent = [active?.quota?.primary, active?.quota?.secondary].find(w => w && w.usedPercent >= 100)
      this.notice = { type: 'switched', email: label || null, minutes: spent?.windowDurationMins ?? null }
      this.message = 'Switched to ' + label + '.'
      return
    }
    const resets = unavailable.flatMap(a => {
      if (!a.signedIn) return []
      const spent = [a.quota?.primary, a.quota?.secondary].filter(w => w && w.usedPercent >= 100)
      if (!spent.length || spent.some(w => !w?.resetsAt)) return []
      return [Math.max(...spent.map(w => w!.resetsAt!)) * 1000]
    }).filter(t => t > Date.now())
    this.notice = { type: 'unavailable', resetAt: resets.length ? Math.min(...resets) : null }
    this.message = 'No Codex account is currently available.' + (resets.length ? ' Next reset: ' + new Date(Math.min(...resets)).toISOString() : '')
    throw new Error(this.message)
  }

  private rememberExhaustion(info: AccountInfo) {
    const spent = [info.quota?.primary, info.quota?.secondary].filter(w => w && w.usedPercent >= 100)
    if (spent.length) this.errors.set(this.slot(info.id, info.workspaceId),
      Math.max(...spent.map(w => w?.resetsAt ? w.resetsAt * 1000 : Date.now() + 60_000)))
  }

  // Queue admissions with switches; existing turns release without entering the queue.
  enterTurn() {
    return this.serial(async () => {
      await this.rotate()
      this.turns++
      return () => {
        if (--this.turns === 0) { this.drained?.(); this.drained = undefined }
      }
    })
  }

  private observed = new WeakSet<AppServerLease['client']>()
  observeUsage(lease: AppServerLease) {
    if (this.observed.has(lease.client)) return
    this.observed.add(lease.client)
    const id = this.config.current
    const scheduleRotation = () => {
      if (this.config.automatic)
        void this.serial(() => this.rotate()).catch(error => { this.message = error instanceof Error ? error.message : 'Could not switch accounts.' })
    }
    lease.client.onNotification('account/rateLimits/updated', raw => {
      const { rateLimits } = raw as { rateLimits?: AccountRateLimitSnapshot }
      if (!rateLimits || (rateLimits.limitId && rateLimits.limitId !== 'codex') || id !== this.config.current) return
      const cached = this.cache.get(id)
      if (cached) cached.info.quota = { ...rateLimits, primary: rateLimits.primary ?? cached.info.quota?.primary ?? null, secondary: rateLimits.secondary ?? cached.info.quota?.secondary ?? null }
      if (exhausted(rateLimits)) scheduleRotation()
    })
    lease.client.onNotification('turn/completed', raw => {
      const event = raw as { turn?: { error?: { codexErrorInfo?: unknown } } }
      if (event.turn?.error?.codexErrorInfo !== 'usageLimitExceeded' || id !== this.config.current) return
      this.errors.set(this.slot(id, this.cache.get(id)?.info.workspaceId), Date.now() + 60_000)
      this.cache.delete(id)
      scheduleRotation()
    })
  }

  async startLogin(device: boolean, existingId?: string): Promise<Login> {
    return this.serial(async () => {
      if (this.pending?.login) return this.pending.login
      // Keep an existing CLI login intact. The first sign-in can use the default Home.
      if (existingId && (!this.config.ids.includes(existingId) || (await this.inspect(existingId, true)).signedIn))
        throw new Error('Select a signed-out account to sign in again.')
      const id = existingId ?? ((await this.inspect(DEFAULT, true)).signedIn ? randomUUID() : DEFAULT)
      if (!this.config.ids.includes(id)) {
        const home = this.key(id)
        mkdirSync(home, { recursive: true, mode: 0o700 })
        try {
          for (const name of ['sessions', 'config.toml', 'AGENTS.md', 'instructions.md', 'skills']) {
            const dir = name === 'sessions' || name === 'skills'
            if (dir) mkdirSync(join(this.base, name), { recursive: true })
            symlinkSync(join(this.base, name), join(home, name), dir ? 'junction' : 'file')
          }
        } catch (err) { rmSync(home, { recursive: true, force: true }); throw err }
      }
      const lease = this.acquire({}, id)
      this.notice = undefined
      this.message = null
      this.pending = { id, lease, timer: setTimeout(() => { void this.cancelLogin().catch(() => {}) }, 12 * 60_000) }
      this.pending.unsubscribe = lease.client.onNotification('account/login/completed', raw => {
        const result = raw as { loginId: string; success: boolean; error?: string }
        void this.serial(async () => {
          if (this.pending?.lease !== lease || this.loginId !== result.loginId) return
          try {
            if (!result.success) throw new Error(result.error || 'Sign-in failed.')
            const info = await this.inspect(id, true)
            if (!info.signedIn) throw new Error('Sign-in was not completed.')
            const identity = this.cache.get(id)!.identity
            for (const other of this.config.ids.filter(x => x !== id)) {
              await this.inspect(other, true)
              const known = this.cache.get(other)?.identity
              if (identity.userId && identity.userId === known?.userId)
                throw new Error('This account is already added.')
            }
            if (!this.config.ids.includes(id)) this.save({ ...this.config, ids: [...this.config.ids, id] })
          } catch (error) { this.message = error instanceof Error ? error.message : 'Sign-in failed.' }
          finally { this.finishLogin() }
        })
      })
      try {
        const result = await lease.client.request<{ authUrl?: string; verificationUrl?: string; userCode?: string; loginId: string }>('account/login/start', { type: device ? 'chatgptDeviceCode' : 'chatgpt' })
        const url = result.authUrl ?? result.verificationUrl
        if (!url) throw new Error('Codex did not return a sign-in URL.')
        this.loginId = result.loginId
        return this.pending.login = { url, code: result.userCode }
      } catch (err) { this.finishLogin(); throw err }
    })
  }

  private loginId?: string
  private finishLogin() {
    const pending = this.pending
    if (!pending) return
    clearTimeout(pending.timer)
    pending.unsubscribe?.()
    this.pending = undefined
    this.loginId = undefined
    pending.lease.release()
    if (!this.config.ids.includes(pending.id)) {
      this.cache.delete(pending.id)
      rmSync(this.key(pending.id), { recursive: true, force: true })
    }
  }
  cancelLogin() {
    return this.serial(async () => {
      try {
        if (this.pending && this.loginId) await this.pending.lease.client.request('account/login/cancel', { loginId: this.loginId })
      } finally { this.finishLogin() }
    })
  }
  remove(id: string) {
    return this.serial(async () => {
      if (id === DEFAULT || id === this.config.current || !this.config.ids.includes(id)) throw new Error('Select another account before removing this account.')
      this.save({ ...this.config, ids: this.config.ids.filter(x => x !== id) })
      this.cache.delete(id)
      // Keep the inactive Home on disk. Removing a list entry must never delete local user data.
    })
  }
  dispose() { this.finishLogin() }
}

export function codexAccounts(ctx: RuntimeContext) {
  return ctx.shared('codex:accounts', () => new CodexAccounts(ctx))
}
