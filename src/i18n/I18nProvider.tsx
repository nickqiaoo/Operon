import { useEffect, useState } from "react"
import { IntlProvider } from "react-intl"
import { useLocaleStore, resolveLocale } from "@/stores/locale-store"
import { loadMessages } from "./messages"

/** Swallow missing-translation warnings — missing keys fall back to the
 *  inline English `defaultMessage`, which is the intended behaviour. */
const noop = () => {}

/**
 * Wraps the app in react-intl. The active locale is derived from the persisted
 * user preference (or the system locale). Catalogs load asynchronously and are
 * only applied once they match the current locale, so a stale catalog never
 * flashes during a switch. English needs no catalog (it is the source language).
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const pref = useLocaleStore((s) => s.localeOverride)
  const locale = resolveLocale(pref)
  const [loaded, setLoaded] = useState<{ locale: string; messages: Record<string, string> } | null>(
    null
  )

  useEffect(() => {
    let cancelled = false
    document.documentElement.lang = locale
    void loadMessages(locale).then((messages) => {
      if (!cancelled) setLoaded({ locale, messages })
    })
    return () => {
      cancelled = true
    }
  }, [locale])

  const messages = loaded?.locale === locale ? loaded.messages : undefined

  return (
    <IntlProvider locale={locale} defaultLocale="en" messages={messages} onError={noop}>
      {children}
    </IntlProvider>
  )
}
