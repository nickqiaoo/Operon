/**
 * "Open with…" — codex-style picker that lists the editors / terminals
 * installed on the machine and opens the active workspace in one of them.
 *
 * macOS-only for now (route A whitelist). The main process resolves which
 * candidate apps are installed, grabs each one's real icon via
 * `app.getFileIcon().toDataURL()`, and launches the chosen app with `open -a`.
 */
/**
 * What an app can sensibly do with a target, which decides how we open a
 * *file* (directories open the same way for all kinds):
 * - `editor`   → open the file in the app
 * - `terminal` → open the file's parent directory (terminals can't open a file)
 * - `finder`   → reveal the file in Finder
 */
export type OpenWithKind = "editor" | "terminal" | "finder"

export interface OpenWithApp {
  /** Stable id (e.g. "vscode"). */
  id: string
  /** Display label shown in the menu (e.g. "VS Code"). */
  label: string
  /** Absolute path to the resolved `.app` bundle. */
  appPath: string
  /** PNG data URL of the app's icon, or null if it couldn't be read. */
  iconDataUrl: string | null
  /** Drives file-open semantics — see {@link OpenWithKind}. */
  kind: OpenWithKind
}

export interface OpenWithRequest {
  appPath: string
  targetPath: string
  /** App kind, so the main process can pick file-open semantics. */
  kind?: OpenWithKind
}

export type OpenWithResult =
  | { success: true }
  | { success: false; error: string }
