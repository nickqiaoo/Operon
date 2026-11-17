/**
 * How the assistant's list tools say which slice of a longer list they show, so the main agent
 * pages every one of them the same way: an `offset` to skip, a `limit` to show, and a total.
 */

export const DEFAULT_PAGE = 20
export const MAX_PAGE = 50

/**
 * "3" when the whole list is shown; otherwise "1–10 of 25; offset 10 for the next" (the hint
 * only while there is a next).
 */
export function pageRange(offset: number, shown: number, total: number): string {
  const end = offset + shown
  if (offset === 0 && end === total) return `${total}`
  const more = end < total ? `; offset ${end} for the next` : ''
  return `${offset + 1}–${end} of ${total}${more}`
}

/** What an empty page says: past the end of a non-empty list, or nothing at all. */
export function emptyPage(offset: number, total: number, none: string): string {
  return offset > 0 && total > 0 ? `No more: there are ${total}.` : none
}
