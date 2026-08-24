import type { ElicitationResult } from "./NodeReplHost.ts";
import type { EmittedImage } from "./ipc.ts";

/**
 * The host integration contract: the hooks a host supplies when wiring this
 * module into a framework. The core knows nothing about them, which is what
 * keeps it independent of any particular framework.
 *
 * All of them are optional; without them the safe defaults apply, meaning
 * elicitation accepts automatically and output is discarded.
 */
export interface ComputerUseIntegration {
  /**
   * Confirmation for a high-risk action, routed to the host's UI.
   * Wire this to your framework's authorization flow. Omitting it accepts
   * automatically.
   */
  requestElicitation?(request: { message: string; meta?: unknown }): Promise<ElicitationResult>;

  /** Text from `nodeRepl.write(text)`, forwarded to the host's chat stream. */
  onOutput?(text: string): void;

  /** Images from `nodeRepl.emitImage(...)`, forwarded to the host's chat stream. */
  onImage?(image: EmittedImage): void;

  /** `nodeRepl.launchServices.openApplication(target)`。 */
  launchApplication?(target: unknown): Promise<void>;
}

/** The safe default integration, used when no host is provided. */
export const defaultIntegration: ComputerUseIntegration = {
  requestElicitation: async () => ({ action: "accept" }),
};
