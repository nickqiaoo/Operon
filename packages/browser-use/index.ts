/**
 * @operon/browser-use: the browser control path.
 *
 * Framework-agnostic, with no `import electron` anywhere in the package:
 *   wire.ts / JsonRpcPeer.ts / IabBackend.ts   protocol layer. Plain Node, testable.
 *        | CdpDriver (interface)
 *   electron/browser-use-driver.ts             the only place that touches Electron,
 *                                              and it lives outside this package.
 */

/** Exposed inside nodeRepl.env so the installed skill never hard-codes an app path. */
export const OPERON_BROWSER_CLIENT_PATH_ENV = "OPERON_BROWSER_CLIENT_PATH";

export {
  IabBackend,
  type IabBackendOptions,
  type CdpDriver,
  type BrowserUseTab,
  type TabOrigin,
  type TabStatus,
} from "./IabBackend.ts";

export { JsonRpcPeer, type RpcRequest, type RpcHandler } from "./JsonRpcPeer.ts";

// Chrome backend: the extension is the backend, these are the pipe to it and its setup.
export {
  ChromeNativeHost,
  type ChromeNativeHostOptions,
  MAX_FRAME_BYTES,
} from "./ChromeNativeHost.ts";
export { runChromeNativeHost } from "./chrome-native-host-main.ts";
export {
  detectChromeExtension,
  chromeUserDataDir,
  type ChromeDetection,
  type ProfileDetection,
  type DetectOptions as ChromeDetectOptions,
} from "./chrome-extension-detect.ts";
export {
  installChromeNativeHost,
  uninstallChromeNativeHost,
  chromeNativeHostStatus,
  wrapperPath as chromeNativeHostWrapperPath,
  NATIVE_HOST_NAME as CHROME_NATIVE_HOST_NAME,
  DEV_EXTENSION_ID as CHROME_DEV_EXTENSION_ID,
  STORE_EXTENSION_ID as CHROME_STORE_EXTENSION_ID,
  DEFAULT_EXTENSION_IDS as CHROME_EXTENSION_IDS,
  type InstallOptions as ChromeNativeHostInstallOptions,
  type InstallResult as ChromeNativeHostInstallResult,
} from "./chrome-native-host-install.ts";
export {
  ChromeAccessDeniedError,
  isAccessDenied as isChromeAccessDenied,
} from "./chrome-fs-access.ts";
export {
  readChromePresence,
  recordHostLifecycle as recordChromeHostLifecycle,
  presenceDir as chromePresenceDir,
  type ChromePresence,
  type ConnectedExtension as ConnectedChromeExtension,
} from "./chrome-host-presence.ts";

export {
  // framing
  FRAME_HEADER_BYTES,
  encodeFrame,
  decodeFrames,
  type DecodedFrames,
  // Socket discovery
  backendSocketDir,
  backendSocketPath,
  // getInfo schema
  type BrowserInfo,
  type BrowserCapability,
  // IAB runtime identity: client and backend must agree on the flavour.
  OPERON_BUILD_FLAVOR,
  BUILD_FLAVOR_ENV,
} from "./wire.ts";
