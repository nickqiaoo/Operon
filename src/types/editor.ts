import type { FileUIPart } from "ai"

export type EditorTabType = "chat" | "diff" | "terminal"

export type InputAttachment = FileUIPart & {
  id: string  // Unique identifier to ensure effect triggers on each new attachment
  content?: string  // Optional text content for text files
  asText?: boolean  // When true, content is merged into the message text instead of sent as file
}

export type EditorTab = {
  id: string
  title: string
  type: EditorTabType
  closable?: boolean
  chatId?: number
  filePath?: string
  content?: string
  provider?: string
  providerId?: string
  isSubAgent?: boolean
  /**
   * A side chat: a throwaway branch of another conversation, rendered as a tab
   * in the right panel rather than in the editor tab strip. It still lives in
   * the editor store because that is where ChatPanel reads a conversation's
   * state from — the editor surfaces just filter it out.
   */
  isSideChat?: boolean
  // Terminal tabs (type === "terminal")
  terminalId?: string
  launch?: string  // logical launcher, e.g. "claude"
  cwd?: string
  options?: {
    autoRun?: boolean
    background?: boolean
    timestamp?: number
    input?: string
    modelId?: string
    /**
     * Permission mode this tab must run in, overriding the picker. Set when the
     * tab is a spawned sub-agent (external_agent_run): nobody is watching it, so
     * it must not open in a mode that stops to ask.
     */
    modeId?: string
    inputAttachment?: InputAttachment
  }
}
