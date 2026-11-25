// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { IntlProvider } from 'react-intl'
import { expect, it, vi } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN.json'
import { SchedulePicker } from './SchedulePicker'

it('switches the open picker and its time controls to the current locale', async () => {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const value = { at: Date.now() + 600_000 }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  try {
    for (const [locale, title, hour, minute] of [
      ['en', 'Schedule message', 'Hour', 'Minute'],
      ['zh-CN', '定时发送', '小时', '分钟'],
    ]) {
      await act(async () => root.render(
        <IntlProvider locale={locale} messages={locale === 'zh-CN' ? zhCN : undefined}>
          <SchedulePicker value={value} open setOpen={() => {}} select={() => {}} focusInput={() => {}} quotaAt={value.at} />
        </IntlProvider>,
      ))
      const panel = document.querySelector('[role="dialog"]')
      expect(panel?.getAttribute('aria-label')).toBe(title)
      expect([...panel!.querySelectorAll('[role="combobox"]')].map(el => el.getAttribute('aria-label'))).toEqual([hour, minute])
      expect(panel?.querySelector('input[type="datetime-local"]')).toBeNull()
    }
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
