# Operon Browser Use — Chrome extension

The Chrome backend for Browser Use. Forked from open-browser-use (MIT); see `NOTICE.md` for
what changed and why, and `LICENSE` for the retained upstream copyright.

Operon has two browser backends behind one client and one skill:

| Backend | Where it runs | Status |
|---|---|---|
| **IAB** | Operon's own Electron `<webview>` + `webContents.debugger` | live (`packages/browser-use/IabBackend.ts`) |
| **extension** | the user's real Chrome, via `chrome.debugger` | this package |

The client picks between them by `getInfo().type`, not by socket path — both are discovered by
scanning one shared directory.

## How a command reaches a tab

```
browser-client ──unix socket──▶ native host ──stdio──▶ this extension ──▶ chrome.debugger
(kernel)        /tmp/operon-     (operon        native    background.js       (CDP)
                browser-use/     --chrome-      messaging
                <id>.sock        native-host)
```

The extension **is** the backend: every method on `BrowserBackend` is an RPC entry point. The
native host (`packages/browser-use/ChromeNativeHost.ts`) understands no method names — it
rewrites JSON-RPC ids so several clients can share one extension, and otherwise forwards
frames untouched. Both hops use the same framing (4-byte native-endian length + UTF-8 JSON),
which is what lets the middle stay dumb.

## Running it

The extension is useless on its own — it connects to a native host that the Operon desktop
app installs.

1. Install the host from Operon, or call `installChromeNativeHost()` from
   `@operon/browser-use`. It writes a wrapper script plus a manifest naming the extension ids
   allowed to connect.
2. Load this directory unpacked: `chrome://extensions` → Developer mode → Load unpacked.
3. Click the extension's icon. The popup shows whether the native host is reachable.

### The extension id is pinned deliberately

`manifest.json` carries a `key` field, which fixes the id at
`igdpiihejmmlnpbhnjoellojnbnnbhia`.

This matters because a native messaging manifest binds `allowed_origins` to specific extension
ids. Without `key`, Chrome derives the id from the install path, so it would differ on every
machine and no fixed `allowed_origins` could ever match. With it, the same id works everywhere
and the host can be wired up before any Web Store listing exists.

The private half of that key is **not** in this repo. Nothing here needs it: Chrome reads only
the public `key` from the manifest, and signing is required only for self-hosted `.crx` files,
which we do not ship.

**Web Store id.** The listing id is `annipikgonognboogflchfnagmhbbipc` (not this pinned
unpacked id). `installChromeNativeHost` allows both by default via `DEFAULT_EXTENSION_IDS`
in `packages/browser-use/chrome-native-host-install.ts`. Store upload zips should omit the
`key` field so Chrome keeps assigning the listing id.

## Tests

`background.test.ts` loads `background.js` into a vm sandbox with a fake `chrome.*` and
exercises the fork's own diff — the handshake, `attachTarget`/`detachTarget`/`markTab`, and the
`turnEnded` disposition. Run from the repo root:

```
npx vitest run packages/chrome-extension
```

Upstream behavior we inherited unchanged is deliberately not re-tested here.
