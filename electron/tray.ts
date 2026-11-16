import { app, Menu, Tray, nativeImage } from 'electron'
import { onInboxEvent } from '../server/src/services/channel-bus.js'
import type { NotificationStorageAdapter } from '../server/src/storage/interface.js'
import type { Notification, UnreadCounts } from '../server/src/types/notification.js'

/**
 * The macOS menu-bar ("status bar") icon — the same kind of entry ChatGPT and
 * other always-running apps keep up there.
 *
 * The glyph is the Operon mark drawn black on transparent and flagged as a
 * *template* image: macOS then tints it itself, white on a dark menu bar and
 * black on a light one, and dims it while the menu is open. A coloured icon
 * would ignore all of that and look foreign next to the system's own.
 *
 * The PNGs are inlined (18pt @1x / @2x) so nothing has to be copied next to the
 * bundled main process at build time. They come from public/favicon.svg with
 * the rounded-square background dropped, and the ring + S curve thinned by
 * `feMorphology erode radius=14` (viewBox units, applied to the two as one group
 * so their seam stays joined) to match the ~2-3px line weight of neighbouring
 * menu-bar icons; the `>_` keeps its weight or it vanishes at 18px. Rendered at
 * 864px and downsampled with Lanczos for clean edges. Thinning further breaks
 * the ring at @1x.
 */
const ICON_1X = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAABvUlEQVR4nG2UzSuEURTGfzPzYmXJQjaUz5kFo6SQZBbyZ5CpYTlZWMiGvTRJ2SjJyho1pNhSs5CkhoVYTBZTVuSjo+dOd955T93e+56P59z73HNOjHpJAN/a9wOTQB8QAHfAJfAY4dsAYjIEHAMfwK/Wj7c/AYZDMQ0gy16AW+/ACJACVoA36XNhMLdZksM+kAZGgQUFljy/FqAQBRYDkjJs67/XO+2gbBviypbJjvQpxfxLUZlNunWdI6BTuivgycvu1qtia4GGnPdO0QxcAF863QFQ9TI36ZtXbHccyOjnTMZWYFWn2QVegHHgRn4JvaKBnkqXCcSBKSsC6gAmgHngGlgDuvTvxJVDRbGGwZaUbQ2VBTOyrXsv5hPeLrthkFWGpNAT4siufQ48RyTwX9tis4FYN+Ws2sAAPqVLi/S4asae2uQW2APm5Fc0h7Iy5z0iEzpyVVc2XVz6wCM9r9hyuCCtyPB42JR+IOJqriAdJbXSz8lQEKnOVlKxLgJjwDRwKF9rKx+jAcwCrUGNE2tYq/RwM1uD14GEwWyM2KiIGiE2WmzEmE8dSK3ZPIMbVj3AlDgw3YMK9D7Clz9S33pd3mGavgAAAABJRU5ErkJggg=='
const ICON_2X = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAEKUlEQVR4nL2Y34uWRRTHP++7q2VUhoXbyhrilReKBEJJlkaR1E0QBEUE2s2K9Gup/6CL2igoo7aCoBASxMvsIjDxKjGkhbwNzGglAkF9w1/tbpzle5Zv0/O8O68LHRieeeb8nHPmzJyZDvUwpO9sMb4auFP9S8DFSr5G6FTSdE3geuAxYCewGVgH3C5cD5gBzgAngGPAb2bYHDDPMmDI+tuBQ8BlCa1pl8SzvUXmQDCsb3jgy0LR38ANeW3O/tMDZYvxryTLZQ9szFPA7xJ6Hbgqxd4C9z1wD7BF4ZwAvlEI3bAZyRzIqCTcXxmW6wrjeIOsjcDbDWHeV2tUEoybsnl56QDwEvAcsBf4ADgn/Ky+r4v/FiVCwiYt8KC5pu/4UkblYtsthghPfL8A7m7hiZT/pFD0gMnrmsLI1qmCdnehexG6aiPAHzbjqQYjYvYripmlomg/2FZRynfaWekaKfD/svCgCY59JIWFh14FthY86YVVCl9m2Y6GmXfs/4TpOVjSZmebWd7TguwI97Jwf2mR3mXGrlT/XUvx91rWR+raKB0ZiW2OT6LDZvWkxlbIqDHgiOF/AV4oZv+84Y+ZwSWkkZNGf7j00jrNPr0w1rAOAp4FfjZB3yqDAp6x8Z9oh65N0nXmprkAe0zYUWPE+uEtdG6dAq6I/ogUvFjpIR8/ajx7HPGoHXrfNXhnTrvy4/JKxPxW4KS5PnZp1J+uMKgjXckTNixAIE6bpbssnh21OBY+M5o/gddsPcRWcNbwj5iMJsjxXcZzOpNotc6YzLBcE76pZZaFpz5X/DH8ARN8qmlfafAQ0pWZNiNbuE9FVe6gGwq3BowCb5n30isBbxbHzEMVZUYatMF27Yuypa9BTeCe21EY80ZlzdNm0PqlQpbQkRGpKEPyo4XqwwHKir4h67eomyDHdxrPWTvhO33akou6q58zlvZbGwQ45PjTxnNIrs+Zt9VOyZvy82xctCEFHDfiJyyjmiDH7zeeaevPa5sYsXYvsMYmkIdw6EK8YcMijFYeHQ7TNvPwFlZp9tSuqPVU8EdxR8vRETYsKIx4nrcj4zbgFRF2+S/k2AUbW1V5pcqwzUtH6EK6z5enfVP50bS4M4veN9dPFri2kFFTfixVoA21ZMjDttZ+1dmWHm+D4ZoCzfeVtS0lbLdgSPqTJjhq64SVqg6yZREX8GlRwq5tO2rKIj930Cnz0HBh3IMF7ce5uTXAGl0Yqor8tmvQNatvNhUeyrNsorgKndMVaa+yKq5OHxUXzpu6mwWDb2px2XvHFrvDPuFT2VJtf60xpVFP2syy9XRNntC1eYuy6rjw5VX7anHhHPgqXRo1qseGfg8JN/TgMKfQ5b/TLeuxoe055mvtuDVhyTAP9BxzMw9WY6qt88EqPHiHcMt+sKoxKOF/edL7Bwl/t6qRjfnNAAAAAElFTkSuQmCC'

function trayIcon(): Electron.NativeImage {
  const image = nativeImage.createEmpty()
  image.addRepresentation({ scaleFactor: 1, dataURL: ICON_1X })
  image.addRepresentation({ scaleFactor: 2, dataURL: ICON_2X })
  image.setTemplateImage(true)
  return image
}

export interface TrayActions {
  /** Bring the main window forward, creating it if it was closed. */
  showWindow: () => void
  /** Show the main window and start a blank chat in it. */
  newChat: () => void
  /** Show the main window on a notification's source (its chat or task). */
  openNotification: (notification: Notification) => void
  openInbox: () => void
  openAssistant: () => void
  checkForUpdates: () => void
}

/** The unread inbox as the menu shows it: counts plus the newest rows of each kind. */
interface TrayInbox {
  counts: UnreadCounts
  /** Unread rows that wait on the user (approvals, questions), newest first. */
  action: Notification[]
  /** Other unread rows (a turn finished, a task done), newest first. */
  info: Notification[]
}

/** Rows listed in the menu, all groups together; the rest are behind "Show All". */
const MENU_ROWS = 8
const LABEL_CHARS = 56
const SUBLABEL_CHARS = 72

// Module-level so the Tray is not garbage-collected (which removes the icon).
let tray: Tray | null = null
let trayActions: TrayActions | null = null
let appTitle = 'Operon'
let inbox: TrayInbox = { counts: { total: 0, action: 0 }, action: [], info: [] }

function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function notificationItem(n: Notification, actions: TrayActions): Electron.MenuItemConstructorOptions {
  return {
    label: truncate(n.title, LABEL_CHARS),
    // Second line under the title (macOS 14.4+; older systems drop it).
    sublabel: n.body ? truncate(n.body, SUBLABEL_CHARS) : undefined,
    click: () => actions.openNotification(n),
  }
}

function buildMenu(actions: TrayActions): Menu {
  const { counts } = inbox
  const assistantUnread = counts.assistantTotal ?? 0
  const action = inbox.action.slice(0, MENU_ROWS)
  const info = inbox.info.slice(0, MENU_ROWS - action.length)
  const items: Electron.MenuItemConstructorOptions[] = []

  if (action.length > 0) {
    items.push({ label: 'Needs Attention', enabled: false })
    items.push(...action.map((n) => notificationItem(n, actions)))
  }
  if (info.length > 0) {
    if (items.length > 0) items.push({ type: 'separator' })
    items.push({ label: 'Unread', enabled: false })
    items.push(...info.map((n) => notificationItem(n, actions)))
  }
  if (items.length === 0 && assistantUnread === 0) {
    items.push({ label: 'No unread messages', enabled: false })
  }
  if (counts.total > 0) {
    if (items.length > 0) items.push({ type: 'separator' })
    items.push({ label: `Show All in Inbox (${counts.total})…`, click: actions.openInbox })
  }
  if (assistantUnread > 0) {
    items.push({ label: `Assistant (${assistantUnread} unread)…`, click: actions.openAssistant })
  }

  items.push(
    { type: 'separator' },
    { label: `Open ${appTitle}`, click: actions.showWindow },
    { label: 'New Chat', click: actions.newChat },
    { type: 'separator' },
    { label: 'Check for Updates…', click: actions.checkForUpdates },
    { type: 'separator' },
    { label: `Quit ${appTitle}`, click: () => app.quit() },
  )
  return Menu.buildFromTemplate(items)
}

function render(): void {
  if (tray == null || trayActions == null) return
  const { counts } = inbox
  const unread = counts.total + (counts.assistantTotal ?? 0)
  const needsYou = counts.action + (counts.assistantAction ?? 0)
  // The number next to the icon is the same unread total as the sidebar's
  // Inbox and Assistant badges together; nothing at all when it is zero.
  tray.setTitle(unread > 0 ? String(unread) : '', { fontType: 'monospacedDigit' })
  const parts = [unread > 0 ? `${unread} unread` : '', needsYou > 0 ? `${needsYou} need you` : ''].filter(Boolean)
  tray.setToolTip(parts.length > 0 ? `${appTitle} — ${parts.join(', ')}` : appTitle)
  tray.setContextMenu(buildMenu(trayActions))
}

export function createTray(actions: TrayActions, title: string): void {
  if (process.platform !== 'darwin' || tray) return
  trayActions = actions
  appTitle = title
  tray = new Tray(trayIcon())
  render()
}

/**
 * Keep the tray in step with the inbox. Reads straight from the server's storage
 * in this same process, so it stays current while the window is hidden and
 * needs nothing from the renderer.
 */
export function watchTrayInbox(
  storage: Pick<NotificationStorageAdapter, 'notificationList' | 'notificationUnreadCounts'>,
): () => void {
  if (process.platform !== 'darwin') return () => {}
  let timer: NodeJS.Timeout | undefined

  const refresh = () => {
    timer = undefined
    try {
      const counts = storage.notificationUnreadCounts()
      inbox = {
        counts,
        action: counts.action > 0
          ? storage.notificationList({ unreadOnly: true, severity: 'action', limit: MENU_ROWS })
          : [],
        info: counts.total > counts.action
          ? storage.notificationList({ unreadOnly: true, severity: 'info', limit: MENU_ROWS })
          : [],
      }
      render()
    } catch (err) {
      console.error('[Tray] inbox refresh failed:', err)
    }
  }

  refresh()
  // One write fires several events (the row, then a counts echo): coalesce them.
  const unsubscribe = onInboxEvent(() => {
    timer ??= setTimeout(refresh, 150)
  })
  return () => {
    unsubscribe()
    clearTimeout(timer)
  }
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
