import { describe, expect, it } from 'vitest'
import { createIntl, type PrimitiveType } from 'react-intl'
import zhCN from '@/i18n/locales/zh-CN.json'

/**
 * The disband dialog's copy, in both locales.
 *
 * ICU plural syntax fails at FORMAT time, not at build time: a malformed `{count, plural, …}`
 * type-checks fine and then throws (or silently renders the raw pattern) the first time a
 * user opens the dialog. That is a bad place to find out, and this dialog is one people see
 * rarely — so the patterns get exercised here instead, at every count that changes the
 * wording.
 */

const EN = {
  desc: "Closes {count, plural, =0 {the team} one {# teammate's session} other {# teammates' sessions}} and frees their names. Undelivered messages between them are dropped.",
  running: '{count, plural, one {# teammate is} other {# teammates are}} working right now and will be cut off mid-task.',
  title: 'Disband {name}?',
} as const

const format = (locale: string, messages: Record<string, string>, id: string, values: Record<string, PrimitiveType>) =>
  createIntl({ locale, messages, onError: () => undefined }).formatMessage({ id }, values)

describe('disband dialog copy', () => {
  it('picks the right plural branch in English', () => {
    const en = { 'd.desc': EN.desc, 'd.running': EN.running, 'd.title': EN.title }
    expect(format('en', en, 'd.desc', { count: 0 })).toContain('the team')
    expect(format('en', en, 'd.desc', { count: 1 })).toContain("1 teammate's session")
    expect(format('en', en, 'd.desc', { count: 3 })).toContain("3 teammates' sessions")
    expect(format('en', en, 'd.running', { count: 1 })).toContain('1 teammate is')
    expect(format('en', en, 'd.running', { count: 2 })).toContain('2 teammates are')
    expect(format('en', en, 'd.title', { name: 'demo' })).toBe('Disband demo?')
  })

  // zh-CN has no plural categories, but the pattern still has to parse and the
  // placeholders still have to be spelled the way the component passes them.
  it('formats the Chinese copy without leaving placeholders behind', () => {
    const messages = zhCN as Record<string, string>
    for (const [id, values] of [
      ['editor.team.disband.title', { name: 'demo' }],
      ['editor.team.disband.desc', { count: 2 }],
      ['editor.team.disband.running', { count: 2 }],
      ['editor.team.disband.transcripts', {}],
      ['editor.team.disband.confirm', {}],
    ] as const) {
      const out = format('zh-CN', messages, id, values)
      expect(out, id).not.toBe('')
      expect(out, id).not.toMatch(/[{}]/)
    }
    expect(format('zh-CN', messages, 'editor.team.disband.desc', { count: 2 })).toContain('2 名队友')
    expect(format('zh-CN', messages, 'editor.team.disband.desc', { count: 0 })).toContain('该队伍')
  })
})
