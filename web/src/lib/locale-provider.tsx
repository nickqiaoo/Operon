import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { LocaleContext, type Locale } from './i18n'

const STORAGE_KEY = 'operon-lang'
/** The docs page kept its own choice before the whole site was translated. */
const LEGACY_DOCS_KEY = 'docs-lang'

function readStored(): Locale | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_DOCS_KEY)
    return saved === 'zh' || saved === 'en' ? saved : null
  } catch {
    return null
  }
}

/** Only the first preference counts: an English browser that lists Chinese second stays English. */
function detectSystem(): Locale {
  if (typeof navigator === 'undefined') return 'en'
  const first = navigator.languages?.[0] ?? navigator.language ?? ''
  return first.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

const TITLES: Record<Locale, string> = {
  en: 'Operon - One Interface, Every AI Coding Agent',
  zh: 'Operon - 一个界面，用上所有 AI 编程 Agent',
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readStored() ?? detectSystem())

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Private mode or blocked storage: the choice still applies to this visit.
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
    document.title = TITLES[locale]
  }, [locale])

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale])
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}
