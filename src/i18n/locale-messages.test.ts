import { describe, expect, it } from 'vitest'
import { createIntl } from 'react-intl'
import zhCN from './locales/zh-CN.json'
import en from './extracted/en.json'

/**
 * Every translated string has to survive being formatted.
 *
 * Two failure modes make it this far otherwise, because neither is a type error and
 * neither throws at import time:
 *
 *  - a placeholder renamed or misspelled in translation (`{name}` → `{nome}`), which
 *    renders the brace literally in front of the user;
 *  - malformed ICU (`{count, plural, …}`), which react-intl reports through `onError`
 *    and then renders as the raw pattern.
 *
 * Both are invisible until someone opens that exact screen in that exact locale, which
 * for a settings sub-tab can be months. Formatting every message once here is cheap.
 */

const source = en as Record<string, string>
const target = zhCN as Record<string, string>

/** Placeholder names the English source declares — what the component actually passes. */
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{\s*([A-Za-z_][\w]*)/g)].map((m) => m[1])
}

/** Rich-text tags the message wraps text in (`<q>…</q>`), which need a render function. */
function tags(message: string): string[] {
  return [...message.matchAll(/<([A-Za-z][\w]*)>/g)].map((m) => m[1])
}

/**
 * A value for every placeholder, typed plausibly: `count`-ish names get a number, and a
 * rich-text tag gets an identity renderer. Without the tag entry react-intl treats the
 * whole pattern as malformed and falls back to the raw string — which would look exactly
 * like the bug this file is hunting for.
 */
function sampleValues(message: string): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const name of placeholders(message)) values[name] = /count|total|num|size|index/i.test(name) ? 2 : 'x'
  for (const tag of tags(message)) values[tag] = (chunks: unknown) => chunks
  return values
}

describe('zh-CN messages', () => {
  const intl = createIntl({ locale: 'zh-CN', messages: target, onError: () => undefined })

  it('formats every translated message without leaving a placeholder behind', () => {
    const broken: string[] = []
    for (const [id, sourceMessage] of Object.entries(source)) {
      if (!(id in target)) continue // untranslated falls back to English — not this test's job
      // A message with rich-text tags formats to an array of nodes; flatten to text.
      const formatted = intl.formatMessage({ id }, sampleValues(sourceMessage) as never)
      const output = Array.isArray(formatted) ? formatted.join('') : String(formatted)
      if (/[{}]/.test(output)) broken.push(`${id} → ${output}`)
    }
    expect(broken).toEqual([])
  })

  it('declares the same placeholders as the English source', () => {
    const mismatched: string[] = []
    for (const [id, sourceMessage] of Object.entries(source)) {
      const translated = target[id]
      if (translated === undefined) continue
      const expected = new Set(placeholders(sourceMessage))
      // A translation may legitimately DROP a placeholder (Chinese often needs fewer
      // words around a number), but inventing one the component never passes cannot work.
      for (const tag of tags(sourceMessage)) expected.add(tag)
      const unknown = placeholders(translated).filter((name) => !expected.has(name))
      if (unknown.length > 0) mismatched.push(`${id}: unknown ${unknown.join(', ')}`)
    }
    expect(mismatched).toEqual([])
  })
})
