import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { isNativeApp, nativePlatform } from './native'

export interface ComposerMenuItem {
  id: string
  title: string
  /** A drawn `ComposerGlyph` (model, thinking, mode, fast, goal), else an SF Symbol name. */
  symbol?: string
  selected?: boolean
  disabled?: boolean
  children?: ComposerMenuItem[]
}

export interface ComposerToken {
  id: string
  title: string
  /** Image attachments: a small square JPEG data URL, shown as a thumbnail instead of a chip. */
  thumbnail?: string
}

export interface ComposerSuggestion extends ComposerToken {
  subtitle?: string
  type?: 'skill' | 'command'
}

export interface ComposerSnapshot {
  id: string
  text: string
  revision: number
  cursor: number
}

export interface NativeComposerState {
  id: string
  text: string
  revision: number
  placeholder: string
  /** Blocks sending only; the field stays editable (a new chat is disabled while its agent starts). */
  disabled: boolean
  submitting: boolean
  running: boolean
  canSteer: boolean
  hasContext: boolean
  attachments: ComposerToken[]
  skills: ComposerToken[]
  suggestions: ComposerSuggestion[]
  menu: ComposerMenuItem[]
  menuTitle: string
  allowAttachments: boolean
  /** The page may refuse this send and keep the draft, so UIKit must not clear the field itself. */
  keepTextOnSend: boolean
}

interface NativeComposerPlugin {
  setScrollButton(options: { id: string; visible: boolean; x?: number; y?: number; size?: number }): Promise<void>
  addListener(name: 'scrollToBottom', listener: (event: { id: string }) => void): Promise<PluginListenerHandle>
  update(state: NativeComposerState): Promise<void>
  /** `applied: false`: another owner configured the editor since, so this anchor was dropped. Older builds resolve nothing. */
  layout(options: { id: string; x: number; width: number; bottom: number; keyboardOpen: boolean }): Promise<{ applied?: boolean } | undefined>
  hide(options: { id: string }): Promise<void>
  /** Drop whatever editor / scroll button a previous load of this page left on screen. */
  reset(): Promise<void>
  addListener(name: 'change', listener: (event: ComposerSnapshot) => void): Promise<PluginListenerHandle>
  addListener(name: 'submit', listener: (event: ComposerSnapshot & { action: 'send' | 'stop' | 'steer' }) => void): Promise<PluginListenerHandle>
  addListener(name: 'action', listener: (event: ComposerSnapshot & { action: string }) => void): Promise<PluginListenerHandle>
  addListener(name: 'resize', listener: (event: { id: string; height: number }) => void): Promise<PluginListenerHandle>
  addListener(name: 'files', listener: (event: { id: string; files: { name: string; type: string; url: string }[] }) => void): Promise<PluginListenerHandle>
}

export const NativeComposer = registerPlugin<NativeComposerPlugin>('NativeComposer')

export function hasNativeComposer(): boolean {
  return isNativeApp() && nativePlatform() === 'ios' && Capacitor.isPluginAvailable('NativeComposer')
}

/**
 * Call once, before the first render. The editor and scroll button are UIKit
 * views above the WebView, so they outlive it: when iOS kills the WebView's
 * content process in the background, Capacitor reloads the page in place and
 * the previous page's composer would stay on screen over the fresh one (over
 * the chat list, behind the tab bar). Bridge calls run in order, so this lands
 * before any composer of this page configures the editor.
 */
export function resetNativeComposerOnLoad(): void {
  if (!hasNativeComposer()) return
  void NativeComposer.reset().catch(() => {})
}
