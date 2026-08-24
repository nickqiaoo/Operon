export interface SaasLoginErrorPayload {
  code: string
  message: string
}

export const SAAS_LOGIN_ERROR = {
  githubOAuthTimeout: 'github_oauth_timeout',
  loopbackTimeout: 'oauth_loopback_timeout',
  tokenExchangeFailed: 'token_exchange_failed',
  nodeRegistrationFailed: 'node_registration_failed',
  loginFailed: 'saas_login_failed',
} as const

export class SaasLoginError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SaasLoginError'
    this.code = code
  }
}

export function normalizeSaasLoginError(err: unknown): SaasLoginErrorPayload {
  if (err instanceof SaasLoginError) {
    return { code: err.code, message: err.message }
  }

  const message = err instanceof Error ? err.message : String(err)
  if (/context deadline exceeded|timed?\s*out|timeout/i.test(message)) {
    return {
      code: SAAS_LOGIN_ERROR.githubOAuthTimeout,
      message:
        'GitHub sign-in timed out while connecting through the broker. Please retry. If you are in mainland China, switch networks or use a proxy and try again.',
    }
  }

  return {
    code: SAAS_LOGIN_ERROR.loginFailed,
    message: message || 'Failed to start sign-in',
  }
}
