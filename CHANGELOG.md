# Changelog

## [1.3.28] - 2026-08-26

### Changed

- The conversation now has a scrollbar.
- Added a rail beside the conversation with one mark per question — click one to jump back to it.
- The chat input no longer draws a border when focused, or changes color with the mode.
- Softened the shadow around the chat input.
- Fixed buttons having no visible hover state in dark mode.
- Tightened the button row at the bottom of dialogs.
- The update dialog no longer uses the brand color.

## [1.3.27] - 2026-08-25

### Changed

- Fixed chats becoming unresponsive when several conversations are open.
- The top loading bar now shows only while a conversation's history is loading.
- Fixed some MCP tool calls failing.
- Fixed auto approval staying off after a temporary model error.
- Fixed a crash caused by tool scripts that exit early.

## [1.3.26] - 2026-08-24

### Changed

- Collect less analytics data.

## [1.3.25] - 2026-08-24

### Changed

- Optimize the update notification UI.

## [1.3.24] - 2026-08-20

### Changed

- Reworked the memory system. Existing memories are reset.

## [1.3.23] - 2026-08-18

### Changed

- Optimize rewind.
- Optimize message list loading.
- Optimize diff layout on mobile.

## [1.3.22] - 2026-08-16

### Changed

- Fixed a cross-process security issue.

## [1.3.21] - 2026-08-10

### Changed

- Add e2e encrypt.

## [1.3.20] - 2026-08-09

### Changed

- Add loading skeleton.

## [1.3.19] - 2026-08-07

### Changed

- Optimize the display of Claude cache invalidation notifications..

## [1.3.18] - 2026-08-07

### Changed

- Fixed the issue of overlapping components above the dialog box.

## [1.3.17] - 2026-08-06

### Changed

- Polished the Workflows panel.

## [1.3.16] - 2026-08-05

### Changed

- Reworked workflows: runs are easier to follow in the Workflows panel.

## [1.3.15] - 2026-08-03

### Changed

- Remote connects through a new address.

## [1.3.14] - 2026-08-01

### Added

- Skills can now be installed per project, not just globally.

## [1.3.13] - 2026-07-31

### Fixed

- Chrome Use no longer skips the permission prompt.

## [1.3.12] - 2026-07-31

### Changed

- Improved the Claude Code usage display.

## [1.3.11] - 2026-07-30

### Added

- Spec-driven changes can now be checked by an independent verifier agent before you sign them off.

## [1.3.10] - 2026-07-30

### Changed

- Upgraded Claude Agent SDK.

## [1.3.9] - 2026-07-29

### Added

- MCP status display.

## [1.3.8] - 2026-07-29

### Fixed

- Reopening an older conversation showed unrelated later edits in its last turn's diff card. Each turn's changes are now pinned when the turn ends.

## [1.3.7] - 2026-07-29

### Added

- Tasks an agent creates now appear as a card in the conversation that opens the task.

### Fixed

- The context window panel reported a much higher percentage than the real usage.

### Changed

- Image attachments are kept outside the conversation, so chats with screenshots load faster and take up far less space. Existing conversations are converted on first launch.
- Chat history and long conversations load faster.

## [1.3.6] - 2026-07-27

### Removed

- The Linear Agent integration (@mentions on Linear issues routing to your machine) is retired — use the built-in task system instead. Sharing a message to Linear as an issue still works.

### Fixed

- Live updates now recover after a dropped connection.
- Backend errors show an error state instead of a blank view.

### Changed

- UI polish and terminal startup improvements.

## [1.3.5] - 2026-07-22

### Added

- Computer Use: agents can now see and operate native macOS apps on your Mac — reading on-screen UI, moving the cursor, clicking, and typing — through a built-in Computer Use engine.

## [1.3.4] - 2026-07-09

### Added

- Prompt-cache regression monitor: flags conversations whose LLM prompt cache stops being read unexpectedly.

### Fixed

- Assistant action row (send-to / copy / share) now stays at the bottom of the turn, even when it ends on a tool call.

## [1.3.3] - 2026-07-07

### Fixed

- Markdown tables (and strikethrough / task lists) now render correctly in chat messages.

### Changed

- Increased chat/markdown line height for more comfortable reading.

## [1.3.2] - 2026-07-01

### Removed

- Dropped the deprecated per-agent live-stream endpoints; sub-agent progress now renders inline from the main chat stream.

## [1.3.1] - 2026-06-20

### Added

- SAAS Page and PWA.

## [1.3.0] - 2026-06-15

### Added

- Refactor memeory system.

## [1.2.0] - 2026-05-29

### Added

- Replicated Codex's sidebar features and UI.

## [1.1.1] - 2026-05-19

### Added

- Slack Quick Setup: one-click Slack app creation via the Apps Manifest API.

## [1.1.0] - 2026-05-14

### Added

- Slack IMBridge: agents can now read, reply, and hold threaded conversations on Slack channels and DMs from inside operon, with inline image support.
- GitHub integration: PR / issue context flows into agent sessions so agents can pick up work from GitHub events.
- Linear integration: per-issue agent sessions backed by isolated git worktrees, with `create_linear_issues` for delegating work to teammate agents and optional `team:<name>` inbox coordination.

## [1.0.6] - 2026-04-18

### Changed

- Add support fot slack.

## [1.0.5] - 2026-04-17

### Changed

- Add Opus 4.7 for claudecode.

## [1.0.4] - 2026-04-17

### Fixed

- Fix agentsdk import error.

## [1.0.3] - 2026-04-16

### Changed

- Refined UI density across the app: tighter line heights, reduced paragraph spacing, and wider content areas for better information density.
- Added collapsible side panels for both the workspace sidebar and the right-side tool panel.
- Optimized Claude Code integration for smoother execution and improved responsiveness.

## [1.0.2] - 2026-04-14

### Added

- Add kimi code provider.

## [1.0.1] - 2026-04-13

### Fixed

- Fix custom compact service.

## [1.0.0-beta.11] - 2026-04-10

### Added

- Add /compact for custom provider.

## [1.0.0-beta.10] - 2026-04-09

### Fixed
- Fix gemini tool approve.

## [1.0.0-beta.9] - 2026-04-08
 
### Fixed
- Fix terminal UI.

## [1.0.0-beta.8] - 2026-04-06

### Added
- Error handling and fallback mechanism for agent wakeUp when message injection fails

### Fixed
- IME composition Enter key bug in prompt input caused by race condition between compositionend and keydown events
- Chat tab memory leak — only actively streaming tabs stay mounted when switching workspaces
- Unnecessary state updates in setWorkspace when workspace hasn't changed

## [1.0.0-beta.7] - 2026-04-01

### Added
- Mid-Stream Message Injection (Steering) — Ability to inject messages during AI streaming for real-time guidance

## [1.0.0-beta.6] - 2026-03-31

### Added
- Streaming status indicators showing active/unread chat counts in workspace sidebar

## [1.0.0-beta.5] - 2026-03-30

### Fixed
- Fix conversation scrolling performance issues.

## [1.0.0-beta.4] - 2026-03-30

### Fixed
- Fixed  cc  subagnet  can't approve

## [1.0.0-beta.3] - 2026-03-27

### Fixed
- Fixed Intel macOS builds shipping `arm64` native modules, which could prevent the app window from opening on macOS 15
- Switched the macOS app icon pipeline to use the pre-rendered PNG source directly to preserve the intended logo colors

## [1.0.0-beta.2] - 2026-03-27

### Changed
- Elapsed time now shows as `XXs` or `Xm Xs` format instead of `XX.Xs`

## [1.0.0-beta.1] - 2026-03-16
