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

/** Rounds a run of notices folds away: messages `[start, end)`, `rounds` of them. */
export type BackgroundRunFold = { start: number; end: number; rounds: number };

/**
 * Runs of rounds that notices started back to back — a release waiting on CI, a
 * build, an upload, each finishing and waking the agent — with nobody speaking in
 * between. A round is a user-role message and the replies after it; a run needs two
 * or more for anything to fold.
 *
 * A run at the end of the conversation folds all but its last round: that reply says
 * where things stand now. Once the user has spoken after a run, none of it is the
 * current state any more, and the whole run folds.
 */
export function backgroundRunFolds(
  messages: readonly UIMessage[],
  triggerOf: (message: UIMessage) => AutomatedTrigger | undefined = automatedTrigger,
): BackgroundRunFold[] {
  const folds: BackgroundRunFold[] = [];
  let runStart = -1;
  let lastRoundStart = -1;
  let rounds = 0;
  /** `next`: where the user spoke after the run; undefined when the run ends the conversation. */
  const close = (next?: number) => {
    if (rounds >= 2) {
      folds.push(next === undefined
        ? { start: runStart, end: lastRoundStart, rounds: rounds - 1 }
        : { start: runStart, end: next, rounds });
    }
    runStart = -1;
    rounds = 0;
  };
  messages.forEach((message, index) => {
    if (message.role !== 'user') return;
    if (triggerOf(message) !== 'notice') {
      close(index);
      return;
    }
    if (runStart < 0) runStart = index;
    lastRoundStart = index;
    rounds += 1;
  });
  close();
  return folds;
}
