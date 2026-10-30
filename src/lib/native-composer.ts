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
}

export interface ComposerSuggestion extends ComposerToken {
  subtitle?: string
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
}

interface NativeComposerPlugin {
  setScrollButton(options: { id: string; visible: boolean; x?: number; y?: number; size?: number }): Promise<void>
  addListener(name: 'scrollToBottom', listener: (event: { id: string }) => void): Promise<PluginListenerHandle>
  update(state: NativeComposerState): Promise<void>
  layout(options: { id: string; x: number; width: number; bottom: number; keyboardOpen: boolean }): Promise<void>
  hide(options: { id: string }): Promise<void>
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
