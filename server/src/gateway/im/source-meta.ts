import type { IMSource, IMSourceMeta } from '../../types/im.js'

const SOURCE_META = new Map<IMSource, IMSourceMeta>()

export function registerIMSourceMeta(meta: IMSourceMeta): void {
  SOURCE_META.set(meta.source, meta)
}

export function listIMSourceMeta(): IMSourceMeta[] {
  return [...SOURCE_META.values()].sort((a, b) => a.label.localeCompare(b.label))
}
