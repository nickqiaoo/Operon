// Web-target auth: PKCE login against the broker, token storage, node selection,
// and a fetch interceptor that attaches the bearer token to broker requests.
// All of this is dead-code-eliminated in the Electron build (__APP_TARGET__).

import { App as CapacitorApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import {
  isNativeApp,
  nativeAuthenticate,
  secureGet,
  secureRemove,
  secureSet,
  NATIVE_REDIRECT_URI,
  NATIVE_URL_SCHEME,
} from './native'
import { unregisterPushDevice } from './push-device'
import { secureBrokerFetch } from './e2ee/secure-fetch'

const BROKER = (import.meta.env.VITE_BROKER_URL ?? '').replace(/\/$/, '')

const TOKEN_KEY = 'operon.web.access'
/**
 * Keychain slot for the native refresh token.
 *
 * The browser client keeps its refresh token in an HttpOnly `SameSite=None`
 * cookie, which the packaged app cannot use: WKWebView's tracking prevention
 * treats the broker as a third party relative to the app's own origin and
 * drops the cookie. The symptom is nasty — sign-in works, the app runs for the
 * access token's lifetime, then every request 401s with no way back. So on
 * native the refresh token travels in the request body and rests in the
 * keychain instead.
 */
const NATIVE_REFRESH_KEY = 'operon.native.refresh'
const NODE_KEY = 'operon.web.node'
const NODE_LABEL_KEY = 'operon.web.node.label'
// Which button was pressed to sign in. Not an authorisation input — purely so
// the "no machines" screen can name it, which matters because GitHub and Apple
// are separate accounts by design (see Store.UpsertUser in the broker) and
// "signed in the other way" is the likeliest reason for an empty list.
// Deliberately client-side: the access token carries no provider claim, and
// adding one would mean a broker change for a hint.
const PROVIDER_KEY = 'operon.web.provider'
const PKCE_KEY = 'operon.web.pkce'
const ACCESS_REFRESH_SKEW_MS = 60_000
const NODE_OFFLINE_CODE = 'node_offline'
// An installed PWA that has no network yet (iOS often resumes one before the
// radio is up) would otherwise hang these fetches forever, leaving the gate
// stuck on its loading phase with no way out.
const AUTH_REQUEST_TIMEOUT_MS = 15_000

export const NODE_OFFLINE_EVENT = 'operon:node-offline'

export interface WebNode {
  nodeId: string
  label: string
  online: boolean
  revoked: boolean
}

interface JwtClaims {
  sub?: string
  exp?: number
}

export interface NodeOfflineEventDetail {
  code: typeof NODE_OFFLINE_CODE
  message?: string
}

// ---- base64url / PKCE helpers ----

function b64url(bytes: Uint8Array): string {
  let str = ''
  for (const b of bytes) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomVerifier(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return b64url(bytes)
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return b64url(new Uint8Array(digest))
}

/**
 * The PKCE verifier has to survive the GitHub round-trip. In a browser tab that
 * is one navigation and `sessionStorage` would do — but an installed PWA hands
 * the cross-origin authorize URL to Safari (or an in-app browser) and is
 * reloaded from `start_url` when the callback comes back, which wipes
 * sessionStorage and made every PWA login fail PKCE and bounce to the login
 * page. localStorage survives that reload. The value is single-use and cleared
 * as soon as the code is exchanged.
 */
function storePkceVerifier(verifier: string): void {
  try {
    localStorage.setItem(PKCE_KEY, verifier)
  } catch {
    // Private-mode / quota failures shouldn't block the redirect: the exchange
    // will fail with a readable "expired sign-in" instead of a silent bounce.
  }
  try {
    sessionStorage.setItem(PKCE_KEY, verifier)
  } catch {
    // Best-effort mirror for the plain-tab case; localStorage is the real store.
  }
}

function takePkceVerifier(): string {
  let verifier = ''
  try {
    verifier = localStorage.getItem(PKCE_KEY) ?? ''
  } catch {}
  if (!verifier) {
    try {
      verifier = sessionStorage.getItem(PKCE_KEY) ?? ''
    } catch {}
  }
  clearPkceVerifier()
  return verifier
}

function clearPkceVerifier(): void {
  try {
    localStorage.removeItem(PKCE_KEY)
  } catch {}
  try {
    sessionStorage.removeItem(PKCE_KEY)
  } catch {}
}

/** fetch with a hard deadline — a hung auth call must not wedge the boot gate. */
async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function decode(token: string): JwtClaims | null {
  try {
    const part = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/')
    if (!part) return null
    return JSON.parse(atob(part)) as JwtClaims
  } catch {
    return null
  }
}

// ---- token / selection state ----

export function getAccessToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t)
}

function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export function notifyNodeOffline(message?: string): void {
  window.dispatchEvent(
    new CustomEvent<NodeOfflineEventDetail>(NODE_OFFLINE_EVENT, {
      detail: { code: NODE_OFFLINE_CODE, message },
    })
  )
}

export function getUserId(): string | null {
  const t = getAccessToken()
  return t ? decode(t)?.sub ?? null : null
}

export function isAuthed(): boolean {
  const t = getAccessToken()
  if (!t) return false
  const c = decode(t)
  return !!c?.sub && !!c.exp && c.exp * 1000 > Date.now()
}

/**
 * Which provider this session signed in with, or null for a session that
 * predates this being recorded. Callers must handle null rather than assuming
 * GitHub — guessing wrong here tells the user to go press the button they
 * already pressed.
 */
export function getAuthProvider(): AuthProvider | null {
  const stored = localStorage.getItem(PROVIDER_KEY)
  return stored === 'github' || stored === 'apple' ? stored : null
}

export function getSelectedNodeId(): string | null {
  return localStorage.getItem(NODE_KEY)
}

export function getSelectedNodeLabel(): string | null {
  return localStorage.getItem(NODE_LABEL_KEY)
}

export function setSelectedNode(id: string, label: string): void {
  localStorage.setItem(NODE_KEY, id)
  localStorage.setItem(NODE_LABEL_KEY, label)
}

/** Forget the chosen node (keeps the login) so the picker shows again. */
export function clearSelectedNode(): void {
  localStorage.removeItem(NODE_KEY)
  localStorage.removeItem(NODE_LABEL_KEY)
}

export async function logout(): Promise<void> {
  // On native the session to revoke is the token we hold, not a cookie — read
  // it before the local wipe, and await the keychain clear before navigating
  // away, or the reload races the delete and the app comes back signed in.
  const nativeRefresh = isNativeApp() ? await secureGet(NATIVE_REFRESH_KEY) : null
  // Before the token goes: the broker authenticates this by the access token and
  // deletes by device token, so it cannot be done after the local wipe. Without
  // it the phone keeps receiving this user's push notifications forever.
  await unregisterPushDevice()
  if (BROKER) {
    void fetch(`${BROKER}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      ...(nativeRefresh
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh: nativeRefresh }) }
        : {}),
    }).catch(() => {
      // Local sign-out should still complete if the broker is offline.
    })
  }
  clearToken()
  clearPkceVerifier()
  await secureRemove(NATIVE_REFRESH_KEY)
  localStorage.removeItem(NODE_KEY)
  localStorage.removeItem(NODE_LABEL_KEY)
  window.location.href = '/'
}

/**
 * Permanently delete the signed-in account, then drop every local trace of it.
 *
 * App Store Guideline 5.1.1(v) requires an in-app path to this for any app that
 * lets you create an account, and it has to actually delete — deactivating or
 * "contact support" is a rejection. The broker erases the user, their machines
 * and their sessions; this side clears the token, the keychain and the node
 * selection so the app cannot come back holding a credential for a user that no
 * longer exists.
 */
export async function deleteAccount(): Promise<boolean> {
  if (!BROKER) return false
  let ok = false
  try {
    const res = await fetchWithTimeout(`${BROKER}/auth/account`, { method: 'DELETE' })
    ok = res.ok
  } catch {
    return false
  }
  if (!ok) return false

  clearToken()
  clearPkceVerifier()
  await secureRemove(NATIVE_REFRESH_KEY)
  localStorage.removeItem(NODE_KEY)
  localStorage.removeItem(NODE_LABEL_KEY)
  window.location.href = '/'
  return true
}

function shouldRefreshAccessToken(token: string | null): boolean {
  if (!token) return true
  const claims = decode(token)
  if (!claims?.sub || !claims.exp) return true
  return claims.exp * 1000 <= Date.now() + ACCESS_REFRESH_SKEW_MS
}

let refreshPromise: Promise<string | null> | null = null

export async function refreshAccessToken(): Promise<string | null> {
  if (!BROKER) return null
  if (refreshPromise) return refreshPromise
  refreshPromise = runRefresh()
    .catch(() => null)
    .finally(() => {
      refreshPromise = null
    })
  return refreshPromise
}

async function runRefresh(): Promise<string | null> {
  // Native sends the refresh token it holds; the browser relies on the cookie
  // riding along with `credentials: 'include'`.
  let body: string | undefined
  if (isNativeApp()) {
    const stored = await secureGet(NATIVE_REFRESH_KEY)
    if (!stored) {
      clearToken()
      return null
    }
    body = JSON.stringify({ refresh: stored })
  }

  const res = await fetchWithTimeout(`${BROKER}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    ...(body ? { headers: { 'content-type': 'application/json' }, body } : {}),
  })
  if (!res.ok) {
    // A rejected refresh session is terminal — drop the stored credential too,
    // or every later attempt replays the same dead token.
    clearToken()
    if (isNativeApp() && res.status === 401) await secureRemove(NATIVE_REFRESH_KEY)
    return null
  }
  const data = (await res.json()) as { access?: string; refresh?: string }
  if (!data.access) {
    clearToken()
    return null
  }
  // The broker rotates the refresh token on every use, so persist the new one
  // before returning — dropping it here would log the user out on next launch.
  if (isNativeApp() && data.refresh) await secureSet(NATIVE_REFRESH_KEY, data.refresh)
  setToken(data.access)
  return data.access
}

export async function ensureAccessToken(): Promise<boolean> {
  const token = getAccessToken()
  if (!shouldRefreshAccessToken(token)) return true
  return (await refreshAccessToken()) !== null
}

// ---- login flow ----

export type AuthProvider = 'github' | 'apple'

/** Kick off PKCE login: redirect the browser to the broker's authorize endpoint. */
export async function login(provider: AuthProvider = 'github'): Promise<void> {
  const verifier = randomVerifier()
  storePkceVerifier(verifier)
  // Recorded before leaving, because the round-trip may come back through a
  // different surface (a system browser sheet on native) and nothing in the
  // response says which provider answered.
  try {
    localStorage.setItem(PROVIDER_KEY, provider)
  } catch {
    // Only costs the hint on the empty-machines screen.
  }
  const native = isNativeApp()
  // GitHub cannot redirect to a custom scheme, so on native the broker sends
  // the browser to `operon://auth/callback` itself and iOS hands the URL to
  // the app (see `installNativeAuthListener`).
  const redirectUri = native ? NATIVE_REDIRECT_URI : `${window.location.origin}/auth/callback`
  // PKCE's S256 challenge needs Web Crypto's subtle.digest, which only exists in a
  // secure context (HTTPS or localhost). Reaching the dev server by LAN IP over
  // http is an *insecure* origin, where crypto.subtle is undefined — calling it
  // would throw and the button would silently do nothing. The broker only accepts
  // no-PKCE for localhost-style dev redirects; production (HTTPS) requires S256 PKCE,
  // and so does every native sign-in.
  const challenge = crypto?.subtle ? await challengeOf(verifier) : null
  const url =
    `${BROKER}/auth/authorize?provider=${provider}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    (challenge ? `&code_challenge=${challenge}` : '')

  if (native) {
    // iOS: a system auth session, which intercepts the redirect to
    // `operon://auth/callback` itself and hands us the URL. It has to, because
    // `SFSafariViewController` silently drops a *server-side* redirect to a
    // custom scheme — the sheet just sits there and the app is never told
    // anything, which is the one failure mode with no error to show.
    const session = await nativeAuthenticate(url, NATIVE_URL_SCHEME)
    if (session.kind === 'cancelled') return
    if (session.kind === 'url') {
      let params: URLSearchParams
      try {
        params = new URL(session.url).searchParams
      } catch {
        deliverNativeAuthResult({ ok: false })
        return
      }
      deliverNativeAuthResult(await exchangeAuthCode(params))
      return
    }
    // Android, or an older iOS shell predating the plugin: a system browser
    // sheet, not an in-app web view. Apple requires the user to be able to see
    // the identity provider's real URL bar, and it keeps the app's own web view
    // (and its localStorage, holding the PKCE verifier) alive underneath
    // instead of reloading it. The result arrives via `appUrlOpen`.
    await Browser.open({ url })
    return
  }
  window.location.href = url
}

/**
 * Receive `operon://auth/callback?code=…` from iOS and finish the exchange.
 *
 * Returns a teardown function. Registered once at boot on native; a no-op
 * everywhere else.
 */
/**
 * Password sign-in, for App Store review only. See `broker/reviewer.go` for why
 * it exists — briefly: GitHub emails a device-verification code the reviewer
 * cannot receive, and Sign in with Apple gives him a fresh account with no
 * paired machine, so neither OAuth route lets him evaluate the app.
 *
 * It reuses the ordinary PKCE exchange: the broker hands back the same one-time
 * code an OAuth callback would, and `/auth/token` still verifies the verifier.
 * The endpoint 404s unless the broker has the credentials configured.
 */
export async function reviewerLogin(username: string, password: string): Promise<CallbackResult> {
  if (!crypto?.subtle) {
    return { ok: false, reason: 'This browser cannot complete a secure sign-in.' }
  }
  const verifier = randomVerifier()
  storePkceVerifier(verifier)
  const redirectUri = isNativeApp() ? NATIVE_REDIRECT_URI : `${window.location.origin}/auth/callback`

  let res: Response
  try {
    res = await fetchWithTimeout(`${BROKER}/auth/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        code_challenge: await challengeOf(verifier),
        redirect_uri: redirectUri,
      }),
    })
  } catch {
    clearPkceVerifier()
    return { ok: false, reason: 'Could not reach the operon service. Check your connection and try again.' }
  }

  if (!res.ok) {
    clearPkceVerifier()
    // 404 means the broker has no review credentials set, which is the normal
    // state — say something truthful rather than "wrong password".
    if (res.status === 404) return { ok: false, reason: 'Review sign-in is not available.' }
    return { ok: false, reason: 'Incorrect username or password.' }
  }

  const data = (await res.json().catch(() => null)) as { code?: string } | null
  if (!data?.code) {
    clearPkceVerifier()
    return { ok: false }
  }
  return exchangeAuthCode(new URLSearchParams({ code: data.code }))
}

/**
 * Where a finished native sign-in is delivered, whichever route it took.
 *
 * On iOS the result comes back as the return value of `nativeAuthenticate`
 * inside `login()`, not as a deep link — but the gate advances from one
 * callback either way, so both routes converge here rather than making the
 * component subscribe twice.
 */
let nativeAuthSink: ((result: CallbackResult) => void) | null = null

function deliverNativeAuthResult(result: CallbackResult): void {
  nativeAuthSink?.(result)
}

export function installNativeAuthListener(onResult: (result: CallbackResult) => void): () => void {
  if (!isNativeApp()) return () => {}
  nativeAuthSink = onResult
  const handle = CapacitorApp.addListener('appUrlOpen', (event) => {
    void (async () => {
      let params: URLSearchParams
      try {
        const url = new URL(event.url)
        if (url.protocol.replace(':', '') !== 'operon' || !url.pathname.endsWith('/callback')) return
        params = url.searchParams
      } catch {
        return
      }
      // Dismiss the auth sheet before the exchange so the user isn't staring at
      // a spent GitHub page while the token round-trips.
      await Browser.close().catch(() => {})
      onResult(await exchangeAuthCode(params))
    })()
  })
  return () => {
    // Only clear the sink if it is still ours — under React's strict-mode
    // double-invoke the second effect registers before the first tears down,
    // and clearing unconditionally would drop the live subscriber.
    if (nativeAuthSink === onResult) nativeAuthSink = null
    void handle.then((h) => h.remove()).catch(() => {})
  }
}

export type CallbackResult = { ok: true } | { ok: false; reason?: string }

/**
 * Handle /auth/callback?code=...: exchange the code for an access token.
 *
 * Always leaves the URL back at `/` — a consumed or rejected code must not stay
 * in the address bar, or a reload (or an installed PWA restoring its last URL)
 * replays it and fails again.
 */
export async function handleCallback(): Promise<CallbackResult> {
  const result = await exchangeAuthCode(new URLSearchParams(window.location.search))
  resetCallbackUrl()
  return result
}

/**
 * Exchange a one-time code for an access token. Shared by both arrivals: the
 * browser's `/auth/callback?code=…` navigation and the native deep link.
 * Deliberately free of any URL side effects — the caller owns those.
 */
async function exchangeAuthCode(params: URLSearchParams): Promise<CallbackResult> {
  const code = params.get('code')
  // The broker redirects back with ?error=... when the provider itself failed.
  const brokerError = params.get('message') ?? params.get('error')

  if (!code) {
    clearPkceVerifier()
    return { ok: false, reason: brokerError ?? undefined }
  }

  const verifier = takePkceVerifier()
  let res: Response
  try {
    res = await fetchWithTimeout(`${BROKER}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      // Asking for the refresh token in the response body instead of a cookie.
      // See NATIVE_REFRESH_KEY for why the cookie is unusable here.
      body: JSON.stringify({ code, code_verifier: verifier, native: isNativeApp() }),
    })
  } catch {
    return { ok: false, reason: 'Could not reach the operon service. Check your connection and try again.' }
  }

  if (!res.ok) {
    // A missing verifier means the sign-in was started in a different context
    // (or storage was cleared); say so instead of silently returning to login.
    if (!verifier) {
      return { ok: false, reason: 'This sign-in expired. Try signing in again.' }
    }
    const body = asRecord(await res.json().catch(() => null))
    return { ok: false, reason: stringValue(body?.message) ?? stringValue(body?.error) }
  }

  const data = (await res.json().catch(() => null)) as { access?: string; refresh?: string } | null
  if (!data?.access) return { ok: false }
  if (isNativeApp() && data.refresh) await secureSet(NATIVE_REFRESH_KEY, data.refresh)
  setToken(data.access)
  return { ok: true }
}

function resetCallbackUrl(): void {
  if (window.location.pathname === '/' && !window.location.search) return
  window.history.replaceState({}, '', '/')
}

export function isCallbackRoute(): boolean {
  return window.location.pathname === '/auth/callback'
}

// ---- nodes ----

export async function fetchNodes(): Promise<WebNode[]> {
  if (!(await ensureAccessToken())) return []
  try {
    const res = await fetchWithTimeout(`${BROKER}/auth/nodes`, { method: 'GET' })
    if (!res.ok) return []
    return (await res.json()) as WebNode[]
  } catch {
    return []
  }
}

// ---- websocket auth ----

/**
 * Subprotocol(s) that authenticate a broker WebSocket. The browser WebSocket API
 * can't set an Authorization header, so the access token rides in
 * Sec-WebSocket-Protocol as `operon.bearer.<token>`; the broker reads it, verifies
 * it, and echoes it back to complete the handshake. Returns undefined when there's
 * no token (the WS is then opened without a subprotocol and the broker rejects it).
 */
export function getBrokerWsProtocols(): string[] | undefined {
  const token = getAccessToken()
  return token ? [`operon.bearer.${token}`] : undefined
}

// ---- fetch interceptor ----

/**
 * Attach the bearer token to every broker-bound request. One hook covers all call
 * sites (api-client, api, SSE helpers, the chat transport) without editing each.
 */
export function installFetchAuthInterceptor(): void {
  if (!BROKER) return
  const orig = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(BROKER)) return orig(input, init)

    const isRefresh = url.startsWith(`${BROKER}/auth/refresh`)
    const isToken = url.startsWith(`${BROKER}/auth/token`)
    const isLogout = url.startsWith(`${BROKER}/auth/logout`)
    const usesRefreshCookie = isRefresh || isToken || isLogout
    const shouldAttachBearer = !usesRefreshCookie

    let token = getAccessToken()
    if (shouldAttachBearer && shouldRefreshAccessToken(token)) {
      token = await refreshAccessToken()
    }

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (shouldAttachBearer && token && !headers.has('authorization')) {
      headers.set('authorization', `Bearer ${token}`)
    }
    const requestInit = {
      ...init,
      headers,
      credentials: usesRefreshCookie ? 'include' : init?.credentials,
    } satisfies RequestInit

    const res = await secureBrokerFetch(orig, input, requestInit)
    await notifyIfNodeOffline(res)
    if (res.status !== 401 || !shouldAttachBearer || !canRetryWithFreshToken(input, init)) {
      return res
    }

    const fresh = await refreshAccessToken()
    if (!fresh) return res
    const retryHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    retryHeaders.set('authorization', `Bearer ${fresh}`)
    const retryRes = await secureBrokerFetch(orig, input, { ...init, headers: retryHeaders })
    await notifyIfNodeOffline(retryRes)
    return retryRes
  }
}

function canRetryWithFreshToken(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  return method === 'GET' || method === 'HEAD'
}

async function notifyIfNodeOffline(res: Response): Promise<void> {
  if (res.status !== 503) return
  const headerCode = res.headers.get('X-Operon-Error-Code')
  if (headerCode === NODE_OFFLINE_CODE) {
    notifyNodeOffline()
    return
  }

  const body = asRecord(await res.clone().json().catch(() => null))
  const code = stringValue(body?.code)
  const error = stringValue(body?.error)
  if (code !== NODE_OFFLINE_CODE && error !== NODE_OFFLINE_CODE && error !== 'agent_offline') return
  notifyNodeOffline(stringValue(body?.message))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
