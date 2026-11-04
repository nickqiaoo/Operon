import { createContext, useContext } from 'react'

/**
 * Site language. English is the default; a visitor whose browser asks for
 * Chinese first gets Chinese, and an explicit pick from the toggle wins over
 * both and is remembered. The provider lives in `locale-provider.tsx`.
 *
 * Copy lives next to the component that renders it, as `{ en, zh }` objects
 * read through `useCopy`, so a section's two languages are edited together.
 */
export type Locale = 'en' | 'zh'

export interface LocaleContextValue {
  locale: Locale
  setLocale: (next: Locale) => void
}

export const LocaleContext = createContext<LocaleContextValue | null>(null)

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale must be used within a LocaleProvider')
  return ctx
}

/** Picks the current language's half of a `{ en, zh }` copy object. */
export function useCopy<T>(copy: Record<Locale, T>): T {
  return copy[useLocale().locale]
}
