# Attribution and fork notes

Forked from [open-browser-use](https://github.com/iFurySt/open-browser-use) at commit
`07a8014d18e05d8579aa9dcb380a3d3b5d4f2a76` (extension version 0.1.41), MIT licensed,
Copyright (c) 2026 Leo. The MIT notice is retained in `LICENSE`.

Upstream files taken as the starting point: `background.js`, `content-cursor.js`,
`popup.{html,css,js}`, `manifest.json`, `images/`.

## Artwork

`icons/` is Operon's own app icon, not upstream's. Upstream's logo was replaced rather than
rebranded around: shipping their mark under the name "Operon Browser Use" would be the exact
impersonation this fork exists to avoid, and a logo is a brand identifier that an MIT grant
over *code* does not obviously cover. Their `logo-source.png` was deleted outright.

`images/cursor-chat.png` is retained from upstream. It is a plain pointer arrow drawn as the
virtual cursor overlay — a functional UI element carrying no identity — and the attribution
above covers it.

## Why we forked instead of using the published extension

Upstream is on the Chrome Web Store as `bgjoihaepiejlfjinojjfgokghnodnhd`, so "just install
theirs" looks tempting. Two independent reasons rule it out, and either alone is decisive.

**Identity and distribution.** A native messaging manifest binds `allowed_origins` to
specific extension IDs. Using their build means our native host declares *their* ID: their
wire changes break our users, their delisting removes our feature, and we would be shipping
under someone else's name. Operon installs under its own identity.

**Protocol drift.** Upstream tracks the April version of the client. The current official
client rejects it — see below.

## What we changed

### `getInfo` now satisfies the official schema

The blocking incompatibility, and a bigger one than any missing method. The client validates
the handshake against:

```
{apiSupportOverrides?: record(boolean), capabilities: {browser?, tab?},
 id: string, name: string, type: "iab"|"extension"|"cdp", metadata?: record(string)}
```

Upstream returns `{name, version, type, metadata}` — no `id`, no `capabilities` (both
required), plus a `version` the schema has no field for. We return a compliant object and echo
the asking client's `session_id` back as `metadata.operonSessionId` so one backend can serve
every session.

The extension deliberately does not publish `metadata.operonBuildFlavor`. One installed
extension is shared by eligible Operon desktop builds; app build-flavor selection applies
only to IAB backends.

We advertise `capabilities: {}`. Our IAB backend advertises `visibility` and `viewport`
because it owns an Electron webview; this one drives the user's own Chrome, where neither is
ours to offer.

### Wire methods the current client calls and upstream lacks

- `attachTarget(tabId, targetId)` / `detachTarget(tabId, targetId)` — per-target CDP
  sessions, needed to reach cross-origin frames. Upstream only attaches per tab.
- `markTab(tabId, status)` — backs `Tab.markHandoff` / `Tab.markDeliverable`, which
  `api.json` lists as `unsupportedByDefaultIn: ["iab", "cdp"]`, i.e. extension-only. The
  client turns any failure of this call into "Please update the ChatGPT Chrome Extension to
  the latest version to continue", which is as clear a statement as we could ask for that a
  current extension is expected to implement it.

`allowDownload(tabId, url)` is **deliberately not implemented**, contrary to what our own
replication plan said. The client guards it with `if (this.clientType === "iab")` and never
sends it to an extension backend. It exists because IAB runs in an Electron webview whose
`will-download` needs the host app's say-so; Chrome downloads do not work that way, so there
is no behavior here to implement. The plan's "4 missing methods" came from statically
extracting `sendSessionRequest("…")` call sites, which cannot see that guard.

### `turnEnded` now applies marks

Upstream only detaches the debugger here, because it implements the finalize flow alone: the
model is told to always call `finalizeTabs({keep})`, so nothing else needs to clean up. The
mark flow's contract is different — "agent-created Chrome tabs are ephemeral and close
automatically when the turn ends unless you mark them" — and under it, a detach-only
`turnEnded` leaks every tab the agent opened.

So `turnEnded` now applies the marks, consuming only marks made by the same turn (marks are
turn-scoped; the latest wins). `finalizeTabs` keeps its existing meaning: `keep` is complete
and authoritative. Both share one disposition routine, so Chrome's grouping rules live in one
place.

The two flows are reconciled by recording the turn `finalizeTabs` ran in, and having
`turnEnded` stand down for that turn. "Has the session gone?" looks like it should be enough
and is not: finalize keeps the session alive when it retains a handoff tab, so a `turnEnded`
that only checked for an empty session would close the one tab finalize just saved.

### `onCDPDetach` is forwarded to the client

Found in review against the official extension and the ChatGPT app's IAB backend. When Chrome
detaches the debugger out from under us — the user opens DevTools, another debugger grabs the
tab, the tab crashes — the client has to be told, so it forgets the tab and re-attaches on the
next call. The official extension does exactly one thing on `chrome.debugger.onDetach`:
`sendCdpDetach(source)`, forwarding the raw source object (the client reads `source.tabId`).

Upstream (obu) kept only the internal bookkeeping and never forwarded the notification, so an
external detach left the client sending CDP to a dead attachment for the rest of the turn, with
no way to recover. We now forward it, matching the official layout: one listener updates the
backend's own state (and clears the tab's target sessions, which upstream also missed), a
second forwards `onCDPDetach` to the client.

This is Chrome-only. The IAB backend defines the same capability in the official app but never
calls it — nobody else attaches a debugger to our own webview — so our IAB backend correctly
does not emit it either.

### Smaller fixes

- `executeCdp` translates `{tabId, targetId}` into the CDP session opened by `attachTarget`.
  `chrome.debugger` routes on `sessionId`, and the client sends `targetId` whenever it did not
  observe the `Target.attachedToTarget` event, so without this that fallback path never works.
- `createTab` honours `preferredWindowId`, which upstream accepted and ignored, so a session's
  tabs stay in one window.
- Dropped upstream's legacy tab-group title migration. It exists to rename groups left by
  older upstream builds; we have never shipped one.
- Rebranded identifiers: native host name, storage keys, alarm names, tab group titles, and
  content-script message types. These are all cross-process names — sharing any of them with
  an installed upstream copy would make the two extensions collide.
- The popup no longer renders `npm install -g open-browser-use` commands. Upstream's host is
  a CLI the user installs; ours is installed by the Operon desktop app.

## Keeping the fork diffable

Upstream's structure and naming were kept deliberately, so `git diff` against a fresh
checkout stays readable. When pulling upstream changes, re-check `getInfo` first: it is where
protocol drift shows up, and it fails as a rejected handshake rather than a clear error.
