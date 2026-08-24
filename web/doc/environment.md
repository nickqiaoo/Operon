# Environment and logs

Three settings that matter when something is not working: what environment agents run in, where their CLIs are found, and what got logged.

## Environment variables

**Settings > Env** sets variables on Operon's server process. Every AI adapter — Claude Code, Codex, OpenCode, and the rest — inherits them, so this is the single place to configure things that live at the environment level:

- proxy settings (`HTTPS_PROXY`, `NO_PROXY`)
- custom API endpoints for a provider
- TLS overrides
- anything else a CLI expects to read from its environment

Individual agents can override these for themselves — see the environment variables field in the [agent editor](channels).

## CLI paths

Operon runs real CLI binaries. It finds them by asking your **login shell**, which is why a CLI that works in your terminal usually just works here too — even when it was installed by a version manager that never touches the system `PATH`.

Each provider tab shows what was resolved:

- **Available** / **Not found** — whether the binary is actually there.
- **Resolution** — the path in use.

Leave the custom path blank to keep automatic discovery. Set one only when discovery picks the wrong binary, or when you need a specific version. If a saved override later disappears, Operon says so explicitly and falls back to the auto-detected path rather than silently failing.

## Debug logging

**Settings > Logs** turns on file logging for troubleshooting. Logs are capped at 10 MB and rotate automatically.

From the same tab you can **View Log** inline, **Refresh** it while reproducing a problem, or **Reveal in Finder** to attach the file to a bug report.

Leave it off for day-to-day use; turn it on when you have something to reproduce.

> The Logs tab is desktop-only — it is hidden in [Remote Web Access](remote-access), since the log file lives on the machine, not in the browser.
