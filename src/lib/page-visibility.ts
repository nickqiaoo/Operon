import { createContext, useContext } from "react"

/**
 * Whether the page this component sits in is the one on screen. The Assistant, Inbox, Board and
 * Channels stay mounted once opened (hidden with display:none) so switching back finds them as
 * they were; anything that listens on `window` — an Escape-to-close — should only act while visible.
 */
export const PageVisibleContext = createContext(true)

export function usePageVisible(): boolean {
  return useContext(PageVisibleContext)
}
