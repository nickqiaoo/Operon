/**
 * Reading Chrome's profile registry is optional, and must stay optional.
 *
 * macOS puts `~/Library/Application Support/Google/Chrome` behind Full Disk
 * Access, so an ungranted app gets `EPERM` from a plain `readdir` — the POSIX
 * mode is the user's own `drwx------`, and no chmod changes it.
 *
 * ## This does not affect whether the feature works
 *
 * The protection carves out one exception: `NativeMessagingHosts/`, inside that
 * same directory, is fully readable and writable without any grant. It has to
 * be — every native messaging app on macOS (1Password, KeePassXC, Claude,
 * Codex) registers there, and the whole mechanism would be dead otherwise.
 * Measured on a machine with no grant: the parent directory, `Local State` and
 * every `Default/*` file are all refused, while `NativeMessagingHosts/` reads,
 * writes and lists normally.
 *
 * So installation works, and so does the connection: Chrome spawns our wrapper
 * and talks over stdin/stdout, never touching a profile. The *only* thing the
 * grant would buy is the settings page's "is the extension installed?" check,
 * which reads `Secure Preferences` under the protected part.
 *
 * ## Which is why we never ask for it
 *
 * Full Disk Access is one of the heaviest grants on macOS — it would hand us
 * every other app's data, mail and messages. Asking for that so a diagnostic
 * row can render a checkmark is wildly out of proportion, and training users to
 * approve it on our say-so is worse than the missing checkmark. A denial is
 * reported as "could not check", never as something to fix.
 */

/**
 * A refusal to read, as opposed to a missing file.
 *
 * `EPERM` is what TCC returns on macOS; `EACCES` is the ordinary-permissions
 * denial, kept so the same handling covers a genuinely unreadable directory.
 */
export function isAccessDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === "EPERM" || code === "EACCES";
}

/**
 * A denial where a write was expected to succeed.
 *
 * Unreachable on a stock macOS + Chrome, per the carve-out above — it exists
 * for the Chromium forks we also install into, in case one of them keeps its
 * manifest directory somewhere the carve-out does not cover. Its job is to be a
 * legible sentence instead of a raw `EPERM … mkdir`, not to send anyone to
 * System Settings.
 */
export class ChromeAccessDeniedError extends Error {
  readonly code = "chrome_access_denied";
  readonly deniedPath: string;

  constructor(deniedPath: string, options?: { cause?: unknown }) {
    super(`macOS denied access to ${deniedPath}, so the native host could not be registered.`);
    this.name = "ChromeAccessDeniedError";
    this.deniedPath = deniedPath;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}
