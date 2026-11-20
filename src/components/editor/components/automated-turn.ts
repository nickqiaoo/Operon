import type { UIMessage } from 'ai';
import { parseBackgroundNotices } from './background-notice';
import { isExternalAgentResultMessage } from './ExternalAgentRenderer';
import { parseSteerNotice } from './SteerNoticeMessage';
import { isSpecWorkflowResult, isWorkflowResultMessage, parseSpecNotice } from './WorkflowResultMessage';
import { extractPeerMessage } from '../utils/chatMetadata';
import { isSteerUserMessage } from './steer-message';

/**
 * A user-role message nobody typed: a background task settling, a Monitor event,
 * a workflow / external agent / spec delivering its result, a runtime steer notice,
 * a teammate's report. MessagePartRenderer draws each of these as a step line rather
 * than a bubble; the reply that follows is the agent reacting to it, not answering
 * the user, so the list draws that reply as hanging off the notice (see MessagesList).
 */
export type AutomatedTrigger =
  /** Drawn as a step line: the rail under the reply hangs off it. */
  | 'notice'
  /**
   * Nothing to hang a rail from: not drawn at all (the card that started it already
   * says it finished), or drawn as a bubble (a teammate's message).
   */
  | 'silent';

export function automatedTrigger(message: UIMessage): AutomatedTrigger | undefined {
  if (message.role !== 'user' || isSteerUserMessage(message)) return undefined;
  // A teammate's message is a bubble, not a step line: no icon for the rail to hang
  // from, and it reads as one side of a conversation rather than an event.
  if (extractPeerMessage(message)) return 'silent';

  const texts: string[] = [];
  for (const part of message.parts ?? []) {
    if (part.type === 'text') texts.push(part.text);
    else if (part.type !== 'step-start') return undefined;
  }
  const text = texts.join('\n').trim();
  if (!text) return undefined;

  if (parseBackgroundNotices(text) !== undefined) return 'notice';
  // Same order as MessagePartRenderer, which hides these two.
  if (isExternalAgentResultMessage(text)) return 'silent';
  if (isWorkflowResultMessage(text)) return isSpecWorkflowResult(text) ? 'silent' : 'notice';
  if (parseSpecNotice(text) !== undefined || parseSteerNotice(text) !== undefined) return 'notice';
  return undefined;
}

export const isAutomatedUserMessage = (message: UIMessage) => automatedTrigger(message) !== undefined;
