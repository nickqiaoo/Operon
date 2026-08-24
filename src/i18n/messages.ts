import type { Locale } from "@/stores/locale-store"

/**
 * Load the message catalog for a locale. English is the source language —
 * its strings live inline as `defaultMessage`, so it has no catalog and
 * resolves to an empty map (react-intl falls back to defaultMessage).
 *
 * Non-English catalogs are dynamically imported so each lands in its own
 * code-split chunk and never bloats the main bundle.
 */
export async function loadMessages(locale: Locale): Promise<Record<string, string>> {
  if (locale === "en") return {}
  switch (locale) {
    case "zh-CN":
      return (await import("./locales/zh-CN.json")).default
    default:
      return {}
  }
}
