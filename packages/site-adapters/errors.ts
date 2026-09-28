/**
 * Typed adapter errors (OpenCLI `@jackwener/opencli/errors` shape).
 *
 * `code` is what an agent branches on: AUTH_REQUIRED means "ask the user to log
 * in", EMPTY_RESULT is a legitimate empty answer, SECURITY_BLOCK means the site's
 * risk control kicked in and retrying right away makes it worse.
 */

export class SiteAdapterError extends Error {
  readonly code: string
  readonly hint?: string

  constructor(code: string, message: string, hint?: string) {
    super(hint ? `${message}\nHint: ${hint}` : message)
    this.name = "SiteAdapterError"
    this.code = code
    this.hint = hint
  }
}

export class ArgumentError extends SiteAdapterError {
  constructor(message: string, hint?: string) {
    super("ARGUMENT", message, hint)
    this.name = "ArgumentError"
  }
}

export class AuthRequiredError extends SiteAdapterError {
  readonly domain: string

  constructor(domain: string, message?: string) {
    super(
      "AUTH_REQUIRED",
      message ?? `Not logged in to ${domain}`,
      `Log in to ${domain} in Chrome, then retry.`,
    )
    this.name = "AuthRequiredError"
    this.domain = domain
  }
}

export class EmptyResultError extends SiteAdapterError {
  constructor(command: string, hint?: string) {
    super("EMPTY_RESULT", `${command} returned no data`, hint)
    this.name = "EmptyResultError"
  }
}

export class CommandExecutionError extends SiteAdapterError {
  constructor(message: string, hint?: string) {
    super("COMMAND_EXEC", message, hint)
    this.name = "CommandExecutionError"
  }
}

export class TimeoutError extends SiteAdapterError {
  constructor(label: string, seconds: number, hint?: string) {
    super("TIMEOUT", `${label} timed out after ${seconds}s`, hint)
    this.name = "TimeoutError"
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
