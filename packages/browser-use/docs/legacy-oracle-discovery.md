# Legacy oracle discovery contract

This note preserves the discovery evidence extracted from the vendored client snapshot at
`vendor/codex-browser-client/scripts/browser-client.mjs`. It describes the legacy oracle,
not Operon's production SDK. Older reverse-engineering notes called the relevant minified
functions `kE`, `yV`, and `bV`; the current vendored snapshot uses `ME`, `kV`, and `AV`.
Those names are build-local implementation symbols, not public APIs.

## Fixed legacy endpoint

The current vendored snapshot resolves its discovery endpoint directly:

```js
ME = platform =>
  platform === "win32"
    ? "\\\\.\\pipe\\codex-browser-use"
    : "/tmp/codex-browser-use";
```

Discovery lists that directory, treats every entry as a candidate socket, connects to each
candidate, and calls `getInfo()`. The snapshot contains these 14 `BROWSER_USE_*` variables:

```text
BROWSER_USE_AVAILABLE_BACKENDS
BROWSER_USE_CODEX_APP_BUILD_FLAVOR
BROWSER_USE_CODEX_APP_VERSION
BROWSER_USE_CONFIG_PATH
BROWSER_USE_DISABLE_AMBIENT_NETWORK
BROWSER_USE_DISABLE_API_MEMBERS
BROWSER_USE_DISABLE_BROWSER_CAPABILITIES
BROWSER_USE_DISABLE_ROLLOUT_TRACKING
BROWSER_USE_DISABLE_TAB_CAPABILITIES
BROWSER_USE_FULL_CDP_ACCESS_ENABLED
BROWSER_USE_PREFERRED_CHROME_EXTENSION_INSTANCE_ID
BROWSER_USE_PREFERRED_CHROME_WINDOW_ID
BROWSER_USE_ROLLOUT_SESSIONS_ROOT
BROWSER_USE_SECURITY_MODE
```

None overrides the discovery endpoint. That is why oracle tests must use the real legacy
directory rather than a temporary injected path.

## Legacy IAB selection

The relevant minified logic is equivalent to:

```js
kV = (iabBackends, sessionId, flavor) =>
  sessionId == null
    ? []
    : iabBackends.filter(
        backend =>
          backend.info.metadata?.codexSessionId === sessionId &&
          (flavor == null ||
            backend.info.metadata.codexAppBuildFlavor === flavor),
      );

AV = async (backends, context) => {
  const iabBackends = backends.filter(backend => backend.info.type === "iab");
  const keptIab = kV(iabBackends, context.codexSessionId, flavor);
  await Promise.all(
    iabBackends
      .filter(backend => !keptIab.includes(backend))
      .map(backend => backend.api.close()),
  );
  return [
    ...backends.filter(backend => backend.info.type !== "iab"),
    ...keptIab,
  ];
};
```

The important contract is that session and flavor filtering apply only to `iab`. Extension
and CDP backends remain available independently of the current app session and flavor.

## Why the oracle has test-local adapters

Operon production uses `/tmp/operon-browser-use` (or the corresponding Windows pipe),
`operonSessionId`, `operonBuildFlavor`, and `OPERON_BROWSER_USE_BUILD_FLAVOR`. The vendored
oracle remains unmodified and recognizes only its legacy directory, metadata keys, and
environment variable.

Therefore the iab-oracle, wire-oracle and sdk-differential suites expose
legacy names only through test-local backend adapters. Do not patch the vendor bundle or
restore legacy names in production code. If the vendored snapshot changes, update this
evidence and the adapters together.
