/**
 * The only Browser Use entry point a model may import directly.
 *
 * Do not export the transport, discovery or any internal class from here. This
 * runs in the trusted realm, and every extra export becomes a way around the
 * public Browser API and its security gate.
 */
export { setupBrowserRuntime } from "./index.ts";
