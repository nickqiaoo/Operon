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

/** 80pt tiles at 3x. */
const THUMBNAIL_PX = 240
const thumbnails = new Map<string, Promise<string | undefined>>()

/**
 * A center-cropped square JPEG of an image attachment, small enough to cross
 * the bridge with every composer update (~15KB). UIKit cannot read the page's
 * `blob:` URLs, so the page draws it. Cached by source URL.
 */
export function composerThumbnail(url: string): Promise<string | undefined> {
  let pending = thumbnails.get(url)
  if (!pending) {
    pending = new Promise<string | undefined>((resolve) => {
      const img = new Image()
      img.onload = () => {
        const side = Math.min(img.naturalWidth, img.naturalHeight)
        if (side === 0) return resolve(undefined)
        const size = Math.min(THUMBNAIL_PX, side)
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) return resolve(undefined)
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size)
        resolve(canvas.toDataURL('image/jpeg', 0.8))
      }
      img.onerror = () => resolve(undefined)
      img.src = url
    })
    thumbnails.set(url, pending)
  }
  return pending
}
