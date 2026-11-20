import { create } from "zustand"
import { persist } from "zustand/middleware"

interface ChatDisplayState {
  /**
   * Fold a finished reply's work (thinking, tool calls, the prose between them)
   * behind one "Worked for …" line, leaving only its final text in view.
   */
  conciseMode: boolean
  setConciseMode: (value: boolean) => void
}

export const useChatDisplayStore = create<ChatDisplayState>()(
  persist(
    (set) => ({
      conciseMode: false,
      setConciseMode: (conciseMode) => set({ conciseMode }),
    }),
    { name: "operon-chat-display" },
  ),
)
