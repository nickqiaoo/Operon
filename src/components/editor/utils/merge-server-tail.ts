import type { UIMessage } from 'ai';

/**
 * Messages to request when syncing the tail from the server.
 *
 * Deliberately larger than `CHAT_PAGE_SIZE`: this page has to span however many
 * messages the server recorded while the client was away, and falling short of
 * that costs the user their whole scrollback (see the no-overlap path in
 * `mergeServerTail`). It is still a small fraction of a long conversation.
 */
export const TAIL_SYNC_SIZE = 20;

/**
 * Splices the server's view of the conversation tail onto the list we already have.
 *
 * The callers want the server's authority over *recent* messages — a turn resumed
 * after a reconnect, a steer that has just been persisted — not a fresh transcript.
 * Replacing the list outright (which is what they used to do) threw away every
 * older page the user had scrolled up to load, and pulled the entire conversation
 * over the wire to do it. On mobile that path runs often enough to be noticed:
 * backgrounding the app, locking the screen and switching networks all reconnect.
 *
 * Alignment is by message id — `tail[0]` is located in `current` and everything
 * from that point on is replaced, so locally-optimistic messages in the overlap
 * lose to the persisted version.
 */
export function mergeServerTail(current: UIMessage[], tail: UIMessage[]): UIMessage[] {
  if (tail.length === 0) return current;
  const anchor = current.findIndex((m) => m.id === tail[0].id);
  // No overlap: the server moved further ahead than one page covers. Taking its
  // view wholesale costs the scrollback, but splicing a non-contiguous tail onto
  // ours would leave a silent hole mid-transcript, which is the worse failure —
  // it looks like messages were deleted rather than merely unloaded.
  if (anchor < 0) return tail;
  return [...current.slice(0, anchor), ...tail];
}
