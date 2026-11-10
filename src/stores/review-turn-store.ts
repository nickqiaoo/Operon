import { create } from 'zustand';

/**
 * Bridges the chat panel's "Review" action to the Review tab: maps a workspace
 * root (cwd) to the chat whose latest turn should be reviewed. The Review tab
 * reads this to enable its "Last turn" diff scope (sidecar snapshot → worktree).
 */
export interface ReviewTurnTarget {
  chatId: number;
  /** Which turn to review (the round's user-message id). Undefined = latest. */
  messageUid?: string;
  /**
   * The clicked turn was the newest one, so the Review tab moves on when a newer
   * turn lands. False keeps it on an older turn the user asked for explicitly.
   */
  followLatest: boolean;
  /** Bumped on every request so the Review tab can re-select the Last-turn scope. */
  nonce: number;
}

interface ReviewTurnState {
  byRoot: Record<string, ReviewTurnTarget>;
  /** Mark a specific turn of `chatId` as the review target for `rootPath`. */
  setTurnChat: (rootPath: string, chatId: number, messageUid?: string, followLatest?: boolean) => void;
}

export const useReviewTurnStore = create<ReviewTurnState>((set) => ({
  byRoot: {},
  setTurnChat: (rootPath, chatId, messageUid, followLatest = false) =>
    set((s) => ({
      byRoot: {
        ...s.byRoot,
        [rootPath]: { chatId, messageUid, followLatest, nonce: (s.byRoot[rootPath]?.nonce ?? 0) + 1 },
      },
    })),
}));

/** The turn the Review tab should show, given the chat's newest changed turn (if known yet). */
export function resolveReviewTurnUid(
  target: Pick<ReviewTurnTarget, 'messageUid' | 'followLatest'> | undefined,
  latestUid: string | undefined,
): string | null {
  if (!target) return null;
  return (target.followLatest ? latestUid : undefined) ?? target.messageUid ?? null;
}
