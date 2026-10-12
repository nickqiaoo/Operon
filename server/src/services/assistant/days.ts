import fs from 'fs'
import path from 'path'
import { ASSISTANT_DIR } from './paths.js'

/**
 * Day notes: one markdown file per local day (`days/2026-10-12.md`), written by the main agent as
 * things happen — the details (amounts, names, what a task found, what was decided) that are too
 * specific for memory.md. memory.md is what the assistant always knows; a day note is what it
 * looks up when the user brings up that day ("what did we find on Oct 10?").
 */
export const DAYS_DIR = path.join(ASSISTANT_DIR, 'days')

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** `YYYY-MM-DD` in local time. */
export function localDate(at: number = Date.now()): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A real calendar date in `YYYY-MM-DD` form (not 2026-02-30). */
export function isDayDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
}

const dayPath = (date: string) => path.join(DAYS_DIR, `${date}.md`)

/** The day's note, or undefined when nothing was written that day. */
export function readDay(date: string): string | undefined {
  try {
    return fs.readFileSync(dayPath(date), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Add an entry to a day's note, under the time it was written. The file starts with the date and
 * weekday, so a note read on its own still says which day it is.
 */
export function appendDay(date: string, text: string, at: number = Date.now()): void {
  fs.mkdirSync(DAYS_DIR, { recursive: true })
  const existing = readDay(date)
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const weekday = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long' })
  const head = existing ?? `# ${date} (${weekday})\n`
  const time = new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  // Filled in on another day (the user tells about yesterday): say when, not a time it never was.
  const heading = date === localDate(at) ? time : `Added ${localDate(at)} ${time}`
  fs.writeFileSync(dayPath(date), `${head.trimEnd()}\n\n## ${heading}\n${text.trim()}\n`)
}

/** Dates that have a note, newest first. */
export function listDays(): string[] {
  try {
    return fs
      .readdirSync(DAYS_DIR)
      .map((f) => f.replace(/\.md$/, ''))
      .filter(isDayDate)
      .sort()
      .reverse()
  } catch {
    return []
  }
}
