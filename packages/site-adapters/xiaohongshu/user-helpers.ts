import { XHS_WEB_HOST, isRecord, toCleanString, type Row } from "./shared.ts"

export function normalizeXhsUserId(input: unknown): string {
  const withoutQuery = toCleanString(input).replace(/[?#].*$/, "")
  const matched = withoutQuery.match(/\/user\/profile\/([a-zA-Z0-9]+)/)
  if (matched?.[1]) return matched[1]
  return withoutQuery.replace(/\/+$/, "").split("/").pop() ?? withoutQuery
}

export function flattenXhsNoteGroups(noteGroups: unknown): unknown[] {
  if (!Array.isArray(noteGroups)) return []
  const notes: unknown[] = []
  for (const group of noteGroups) {
    if (!group) continue
    if (Array.isArray(group)) {
      for (const item of group) if (item) notes.push(item)
      continue
    }
    notes.push(group)
  }
  return notes
}

/** Signed user-profile note URL. */
export function buildXhsNoteUrl(userId: unknown, noteId: unknown, xsecToken: unknown): string {
  const cleanUserId = toCleanString(userId)
  const cleanNoteId = toCleanString(noteId)
  if (!cleanUserId || !cleanNoteId) return ""
  const url = new URL(`https://${XHS_WEB_HOST}/user/profile/${cleanUserId}/${cleanNoteId}`)
  const cleanToken = toCleanString(xsecToken)
  if (cleanToken) {
    url.searchParams.set("xsec_token", cleanToken)
    url.searchParams.set("xsec_source", "pc_user")
  }
  return url.toString()
}

export interface XhsUserNoteRow {
  id: string
  title: string
  type: string
  likes: string
  cover: string
  url: string
}

/** Normalise a Pinia user-store snapshot into rows. */
export function extractXhsUserNotes(snapshot: Row, fallbackUserId: string): XhsUserNoteRow[] {
  const rows: XhsUserNoteRow[] = []
  const seen = new Set<string>()
  for (const raw of flattenXhsNoteGroups(snapshot.noteGroups)) {
    const entry = isRecord(raw) ? raw : {}
    const cardRaw = entry.noteCard ?? entry.note_card ?? entry
    if (!isRecord(cardRaw)) continue
    const noteCard = cardRaw
    const noteId = toCleanString(noteCard.noteId ?? noteCard.note_id ?? entry.noteId ?? entry.note_id ?? entry.id)
    if (!noteId || seen.has(noteId)) continue
    seen.add(noteId)
    const user = isRecord(noteCard.user) ? noteCard.user : {}
    const userId = toCleanString(user.userId ?? user.user_id ?? fallbackUserId)
    const xsecToken = toCleanString(entry.xsecToken ?? entry.xsec_token ?? noteCard.xsecToken ?? noteCard.xsec_token)
    const interact = isRecord(noteCard.interactInfo)
      ? noteCard.interactInfo
      : isRecord(noteCard.interact_info)
        ? noteCard.interact_info
        : {}
    const likes = toCleanString(interact.likedCount ?? interact.liked_count ?? 0) || "0"
    const cover = isRecord(noteCard.cover) ? noteCard.cover : {}
    rows.push({
      id: noteId,
      title: toCleanString(noteCard.displayTitle ?? noteCard.display_title ?? noteCard.title),
      type: toCleanString(noteCard.type),
      likes,
      cover: toCleanString(cover.urlDefault ?? cover.urlPre ?? cover.url ?? ""),
      url: buildXhsNoteUrl(userId || fallbackUserId, noteId, xsecToken),
    })
  }
  return rows
}
