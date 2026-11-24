/**
 * Task numbers a message links as `#Task N` (case-insensitive, e.g. `#Task 25`,
 * `#task25`), in order of first appearance. A bare `#25` is left alone on purpose:
 * agents write `#N` for PRs, issues, list items and more, so only the prefix the
 * channel prompt asks for counts as a task link.
 *
 * Code is stripped first so a mention inside a snippet doesn't count. The prefix
 * must not be glued to a word or URL before it (`abc#Task 3`, `/page#Task 3`), and
 * the number must not run on into letters after it (`#Task 25a`).
 */
export function taskNumbersIn(content: string): number[] {
  const prose = content
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
  const seen = new Set<number>()
  for (const match of prose.matchAll(/(?<![\w#/&])#task[ \t]?(\d{1,6})(?![\w-])/giu)) {
    const number = Number(match[1])
    if (number > 0) seen.add(number)
  }
  return [...seen]
}
