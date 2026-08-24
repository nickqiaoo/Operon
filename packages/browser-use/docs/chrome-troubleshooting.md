# Chrome Troubleshooting
## General Guidance
- If communication with the Operon Chrome Extension ultimately fails, even after checks, do not attempt to complete the user's request using AppleScript, shell commands, or other scripting methods.
- Do not install or repair the native host yourself. If native host setup appears broken, tell the user to open Operon Settings → Chrome and reinstall the native host.

## Chrome Extension Checks
On the first Chrome-backed browser task in a session, try a lightweight browser-client call such as listing open tabs after bootstrap. If the call fails, wait 2 seconds and retry the same lightweight browser-client call once. Any non-error response means the extension is installed and working.

If browser-client still reports that it cannot communicate with Chrome after that retry, confirm that Chrome is installed, running and that the extension is present in the selected Chrome profile:

From the plugin root, use `node_repl` to run:

```
scripts/chrome-is-running.js --check
scripts/installed-browsers.js --check
scripts/check-extension-installed.js --json
scripts/check-native-host-manifest.js --json
```

Depending on the outcome follow the following checks. Be sure to ask the user permission when required, if it is stated in the check.

### 1. Chrome is not installed
Keep the first response short and non-technical unless the user asks for more information.

If Chrome is not installed, then inform the user that this plugin only works with the Chrome browser.

### 2. Chrome is not running
Keep the first response short and non-technical unless the user asks for more information.

If Chrome is not running then ALWAYS ask the User if they would like to launch Chrome. ALWAYS wait for a user response before taking action.

### 3. The native host manifest is not installed, or is invalid
Keep the first response short and non-technical unless the user asks for more information.

Do not install or repair the native host yourself. If native host setup appears broken, tell the user to open Operon Settings → Chrome and reinstall the native host.

### 4. The Operon Chrome Extension is not installed
Keep the first response short and non-technical unless the user asks for more information.

If the Operon Chrome Extension is missing, tell the user:

`Cannot communicate with the Operon Chrome Extension. Confirm that the extension is installed and enabled in Chrome.`

Ask the user if you can open the Chrome Web Store page so they can verify that the extension is installed. ALWAYS wait for a user response before taking action. Refer to it as the [Operon Chrome Extension](https://chromewebstore.google.com/detail/annipikgonognboogflchfnagmhbbipc), not by its extension ID.

The Operon Chrome Extension URL is `https://chromewebstore.google.com/detail/annipikgonognboogflchfnagmhbbipc`.

### 4. The Operon Chrome Extension is not enabled
Keep the first response short and non-technical unless the user asks for more information.

If the Operon Chrome Extension is not enabled, ask the user if you can open the Google Chrome Extension Manager so they can verify that the extension is enabled. ALWAYS wait for a user response before taking action. Always refer to the Google Chrome Extension Manager as [Google Chrome Extension Manager](chrome://extensions/).

### 5. Operon Chrome Extension is installed and enabled, the manifest file is installed, but communication still fails
Keep the first response short and non-technical unless the user asks for more information.

If Chrome is running and the extension/native-host checks pass, ask the User if you can open a Chrome window for the selected Chrome profile and retry the connection. ALWAYS wait for a user response before taking action.

If the User agrees, run:

```
scripts/open-chrome-window.js
```

Then wait 2 seconds and retry the browser-client setup once.

After one successful setup check in a session, do not repeat extension detection unless browser-client reports an extension connection failure.

If the issue is specifically the native host or extension-backed install path, or if communication still fails after opening a Chrome window and retrying setup once, tell the user to open Operon Settings → Chrome and reinstall the native host.

## Commands
### installed-browsers.js
This script reports which browsers are installed.

From the plugin root, use `node_repl` to run:

```
scripts/installed-browsers.js
```

Use JSON output when another tool or script needs structured data:

```
scripts/installed-browsers.js --json
```

### chrome-is-running.js
This script checks whether Google Chrome is actively running. It exits `0` when Chrome is running, `1` when Chrome is not running, and `2` for usage or runtime errors.

From the plugin root, use `node_repl` to run:

```
scripts/chrome-is-running.js --check
```

Use JSON output when another tool or script needs structured data:

```
scripts/chrome-is-running.js --json
```

### open-chrome-window.js
This script opens `about:blank` in a Google Chrome window for the same selected Chrome profile used by `check-extension-installed.js`. Use it only after the User gives permission.

From the plugin root, use `node_repl` to run:

```
scripts/open-chrome-window.js
```

Use dry-run JSON output when another tool or script needs to verify the selected launch command without opening Chrome:

```
scripts/open-chrome-window.js --dry-run --json
```

### check-extension-installed.js
This script checks every usable Google Chrome profile for the configured extension and reports whether each profile has it registered, installed, and enabled. The JSON output includes the full `profiles` array plus a `selectedProfileDirectory` hint from `Local State` when available. The top-level `installed`, `enabled`, and exit code reflect the selected profile so Chrome troubleshooting can decide whether the profile it will launch is actually ready. It exits `0` when the selected profile has the extension installed and enabled, `1` when the selected profile has it installed but not enabled, `2` when the selected profile does not have it installed, and `3` for usage or runtime errors.

From the plugin root, use `node_repl` to run:

```
scripts/check-extension-installed.js
```

Use JSON output when another tool or script needs structured data:

```
scripts/check-extension-installed.js --json
```

The Operon settings check scans every `Default` or `Profile X` directory with `Preferences` and marks the profile that `Local State` would have selected.

### check-native-host-manifest.js
This script checks whether the Chrome Native Messaging Host manifest exists for the configured native host name and allows the Chrome extension ID from `scripts/extension-id.json`. On Windows it also checks the Chrome NativeMessagingHosts registry key. It exits `0` when correct, `1` when missing or incorrect, and `2` for usage or runtime errors.

From the plugin root, use `node_repl` to run:

```
scripts/check-native-host-manifest.js
```

Use JSON output when another tool or script needs structured data:

```
scripts/check-native-host-manifest.js --json
```
