export type OpenInIdeApp =
  | "vscode"
  | "cursor"
  | "antigravity"
  | "xcode"
  | "zed"
  | "finder"

export type OpenInIdeRequest = {
  app: OpenInIdeApp
  targetPath: string
  line?: number
  column?: number
}

export type OpenInIdeResult =
  | { success: true }
  | { success: false; error: string }
