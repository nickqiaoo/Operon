import { create } from "zustand"
import { persist } from "zustand/middleware"

interface ReviewDisplayState {
  wordWrap: boolean
  wordDiff: boolean
  toggleWordWrap: () => void
  toggleWordDiff: () => void
}

export const useReviewDisplayStore = create<ReviewDisplayState>()(
  persist(
    (set) => ({
      wordWrap: false,
      wordDiff: false,
      toggleWordWrap: () => set((s) => ({ wordWrap: !s.wordWrap })),
      toggleWordDiff: () => set((s) => ({ wordDiff: !s.wordDiff })),
    }),
    { name: "operon-review-display" },
  ),
)
