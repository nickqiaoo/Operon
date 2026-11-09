/**
 * Session - provides mid-execution control for Codex app-server turns
 *
 * The Session object is exposed via the `onSessionCreated` callback and provides
 * methods for injecting messages mid-execution and interrupting active turns.
 */

import { CodexRpcError, type AppServerClient } from './app-server-client.js';
import type { Session as ISession, UserInput } from './types/index.js';
import type { ProtocolUserInput } from './protocol/index.js';
import { RuntimeInjectionUnavailableError } from '../../../types.js';

/**
 * Convert public UserInput type to protocol format
 */
function toProtocolInput(input: UserInput): ProtocolUserInput {
  switch (input.type) {
    case 'text':
      return { type: 'text', text: input.text };
    case 'image':
      return { type: 'image', url: input.imageUrl };
    case 'localImage':
      return { type: 'localImage', path: input.path };
  }
}

/**
 * Session implementation for mid-execution control
 */
export class SessionImpl implements ISession {
  private _turnId: string | null = null;
  private _isActive = false;

  constructor(
    private client: AppServerClient,
    public readonly threadId: string
  ) {}

  get turnId(): string | null {
    return this._turnId;
  }

  isActive(): boolean {
    return this._isActive;
  }

  /**
   * Called internally when a turn starts
   */
  _setTurnId(turnId: string): void {
    this._turnId = String(turnId);
    this._isActive = true;
  }

  /**
   * Called internally when a turn completes
   */
  _setInactive(): void {
    this._isActive = false;
  }

  /**
   * Inject a message into the active execution.
   *
   * Requires an active turn and uses turn/steer with expectedTurnId.
   * Never starts a new turn or interrupts the current output.
   *
   * @param content - String message or array of UserInput objects
   * @param options.clientUserMessageId - Echoed back as `clientId` on the input's `userMessage` item
   */
  async injectMessage(content: string | UserInput[], options?: { clientUserMessageId?: string }): Promise<void> {
    const inputs: UserInput[] =
      typeof content === 'string' ? [{ type: 'text', text: content }] : content;

    const protocolInputs = inputs.map(toProtocolInput);

    if (!this._isActive || !this._turnId) {
      throw new RuntimeInjectionUnavailableError('No active Codex turn to steer');
    }
    try {
      await this.client.steerTurn({
        threadId: this.threadId,
        expectedTurnId: this._turnId,
        input: protocolInputs,
        ...(options?.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}),
      });
    } catch (error) {
      if (error instanceof CodexRpcError && (error.code === -32600 || error.code === -32602)) {
        throw new RuntimeInjectionUnavailableError(error.message);
      }
      throw error;
    }

  }

  /**
   * Interrupt the current turn if one is active.
   */
  async interrupt(): Promise<void> {
    if (!this._isActive || !this._turnId) {
      return; // Nothing to interrupt
    }

    await this.client.interruptTurn({
      threadId: this.threadId,
      turnId: this._turnId,
    });

    this._isActive = false;
  }
}
