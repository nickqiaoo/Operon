import type { Notification } from "./notification"

/** What the macOS menu-bar (tray) menu asks the window to do. */
export type TrayCommand =
  | { type: "new-chat" }
  | { type: "open-notification"; notification: Notification }
  | { type: "open-inbox" }
  | { type: "open-assistant" }
