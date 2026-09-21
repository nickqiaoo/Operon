# Changelog

## [Unreleased]

## [1.3.39] - 2026-09-21

### Changed

- The Codex quota badge follows your plan's 5-hour window instead of whichever pool has been used the most.
- Usage percentages are grey again — only the bars change colour as a window fills up.
- The queued-message list is tighter and no longer highlights a row when you pass over it.

## [1.3.38] - 2026-09-19

### Changed

- The title bar shows how much quota each signed-in provider has left, with a refresh button.
- Claude's usage updates while a reply is streaming instead of waiting for the next poll.
- Refreshing usage now actually re-reads it rather than repeating the cached number.
- Usage bars follow the 5-hour window and use a softer red; the percentages themselves stay grey.
- Create PR moved from the chat box to the review toolbar, and uses your own `gh` login — no token to paste, and the old one is deleted from the database.
- PR titles and descriptions are drafted from the diff, and you can stop the draft while it runs.
- Draft PRs, opening a PR in the browser, and jumping to a branch's existing PR are all in the review toolbar.
- Stopping a reply no longer discards the part that was already on screen.
- Usage and context cards above the chat box open when you rest on them, not when you pass over them.

## [1.3.37] - 2026-09-18

### Changed

- The context window popover colour-codes where your tokens go, with a bar across the top and a swatch on every row.
- Rows that sit outside the context window show "—" instead of a made-up percentage, and moved to the bottom of the list.
- Projects and workspaces have their own icons in the sidebar, and a workspace now lines up under its project's name.
- Sidebar text and icons are easier to read against the rail.
- Pasted and attached images reach the agent again.
- The chat column lines up with the composer below it, and a reply now runs the full width.

## [1.3.36] - 2026-09-17

### Changed

- Opening or closing the right panel keeps the chat pinned to the bottom; narrowing text grows upward instead of sliding.
- Approving a new phone or browser now only works from the desktop window, and every new device shows up in the inbox and as a system notification.
- Diff cards offer Undo only on the latest turn that changed files; older turns can be rewound from the user message with "Rewind to here". Rewinding never touches the conversation.
- Codex rate limits open on hover on desktop and in a sheet on mobile; Claude and Codex usage bars turn green, orange and red as a limit gets close.
- Tool calls show an icon for their kind, keep the file name visible in long paths, and no longer jump from a card to a row when they finish.
- Browser tabs show the page's favicon and a shorter title.
- Slow folders in the file tree show a spinner while they load, and long names no longer flicker while scrolling.
- Code blocks show syntax colors in light theme and have a more compact header.
- Scroll areas next to toolbars and the composer fade at the edge instead of cutting a line in half.
- Settings tabs are grouped, with AI Providers first.

## [1.3.35] - 2026-09-15

### Changed

- Chat tabs show a warning mark when the agent is waiting for your answer, approval or plan review.
- External agent cards show what the agent is waiting for, and let you allow or deny a tool request right from the card.
- External agents keep running and report back even when the tab that launched them is closed.
- Phone pushes are held while you are using the computer and sent once you step away; the iOS app no longer shows a banner for events it is already displaying.
- Several OpenCode tabs open at once no longer mix up each other's tool calls.
- Sub-agent tabs show the model they actually run instead of the first one in the list.
- Antigravity file searches that fail no longer spin forever.

## [1.3.34] - 2026-09-14

### Changed

- Scrolling over a Mermaid diagram in Markdown now scrolls the page; hold Ctrl (or pinch) to zoom the diagram.
- Mermaid diagrams use the same compact frame as code blocks, and stay readable in dark mode.
- The file preview has find: press ⌘F (Ctrl+F) to search the open file, with match case, whole word and regex.
- Opening another file in the file preview keeps the current one open in a strip of up to 8 files; the least recently viewed one closes first, and the file tree follows whichever file is on screen.
- Reopening the file tree reveals and scrolls to the file you were viewing.
- On web and mobile, a failed machine list shows the reason and a Retry button instead of an empty list or a false "Offline".
- Extensions and Linear settings say when they are unavailable on the connected machine instead of showing an error.

## [1.3.33] - 2026-09-13

### Changed

- The iOS app has a native tab bar and navigation bar, and the inbox, agent picker, model picker, context usage and subscription usage open as native sheets.
- Phones get a dedicated sign-in screen, larger chat text, and layouts that stay clear of the notch and the tab bar.
- The Android app gets the same native navigation bar and system sheets.
- Linear and GitHub can now be installed as apps: delegate a Linear issue to Operon and it becomes a task in the repo named by its `repo:owner/name` label, run by your default agent, with progress posted back to the issue.
- Task status, title, description, priority and comments stay in sync with the linked Linear issue in both directions.
- Agents can open pull requests on their own, and PR comments from the task owner send them back to work.
- Tasks can be published to Linear from the task page.
- Replies under a channel message are easier to spot and show when the last one came in.
- The desktop reconnects on its own when its remote-access connection silently drops.

## [1.3.32] - 2026-09-07

### Changed

- Computer Use runs on a new engine. It can now press keyboard shortcuts, pick items from an app's menu bar, resize a window, zoom into part of one, and read or write the clipboard — none of which it could do before.
- Computer Use can search a window for the controls it needs instead of reading the whole screen, which makes it quicker in large apps like Chrome.
- Computer Use can confirm an action actually took effect rather than assuming it did.
- Reading the whole screen or the clipboard now asks for its own permission, separately from approving an app.
- The Computer Use preview window is gone; the agent's pointer is shown on screen as it works instead.
- Google Antigravity is now a provider; Settings installs its ACP server for you and tells you whether it is signed in, so a Google login page never appears mid-conversation.
- Grok, Kimi, Cursor and Antigravity conversations pick up where they left off after you restart Operon, instead of starting over with no memory of the chat.
- Removed the Gemini CLI provider, which no longer works.
- New Terminal can open the Antigravity CLI.
- Skills can be installed for Antigravity.
- Agents can now hand work to Grok and Antigravity through the external-agent tool.

## [1.3.31] - 2026-09-04

### Changed

- Teams are now per repository: each project you open keeps its own teammates, mailbox and budget, and a teammate is spawned into the repo its lead is working in.
- Computer Use and the browser are ready from the first line of code, so the agent no longer spends a turn setting them up.
- The agent is now told which of Computer Use, the in-app browser and Chrome are actually on, instead of being offered ones you turned off.
- Open chats share one JavaScript runtime process instead of one each, cutting a few hundred megabytes with six conversations open.
- A runaway script's output is trimmed in the middle rather than filling the conversation.
- The agent can reset its JavaScript session on its own; your browser tabs and apps stay as they are.
- Extensions that failed to load now say so, with what went wrong and a Try again button, instead of showing as approved.
- Operon looks for a compatible build of a broken extension on every launch and loads it once one is published.
- The marketplace only lists extensions that run on your version of Operon.

## [1.3.30] - 2026-09-02

### Changed

- Teams is now a built-in extension: it appears in Settings → Extensions with Load / Unload, and its settings sit behind a Configure button on its row instead of a separate tab.
- Teammate names only need to be unique within their team; teammates address their lead as `lead`.
- A teammate's message now shows as a card with its sender's name instead of looking like something you typed.
- The Team panel's token total can be expanded to see who spent it.
- Disbanding a team now asks first, and says how many teammates are mid-task.
- The Session panel is split into what's happening now and what the session can do; sections with nothing in them no longer take up space.
- Tightened the Session panel: healthy servers no longer announce themselves, row controls appear on hover, and the whole session fits on one screen.
- Click a skill in the Session panel to read it, then drop its slash command into the composer; plugin and extension rows open their repo or their settings.
- Click a connected MCP server in the Session panel to see the tools it offers.
- An empty panel now lists the things you can open as plain rows instead of big cards.
- Opening the bottom panel goes straight to a terminal.
- Keyboard shortcuts for opening Files, Review, Browser, Terminal and a side chat; the new-tab menu shows the keys.
- Added Settings → Keyboard shortcuts, where every shortcut can be rebound, given a second key, or removed.
- An extension shows as updatable when the framework inside it moves, not only when its own version does.
- The Chinese interface is complete again — extensions, the session panel, shortcuts, teams and account screens were still falling back to English.

## [1.3.29] - 2026-09-01

### Changed

- Side chats now work with Claude Code and OpenCode, not just Codex.
- Select text in a reply to add it to the chat, or ask about it in a side chat.
- Select text in a file preview to add it to the chat.
- Markdown previews have an outline button for jumping between headings.
- Trimmed the side padding in markdown previews.
- Toggling fast mode no longer restarts the conversation's agent session.

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
