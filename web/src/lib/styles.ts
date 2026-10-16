/** Joins class names, dropping falsy entries. */
export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ')
}

/* ===== Buttons ===== */

export const buttonPrimary =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-foreground px-4 text-[14px] font-medium text-background transition-colors hover:bg-primary-hover whitespace-nowrap'

export const buttonSecondary =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-border/60 bg-background px-4 text-[14px] font-medium text-foreground transition-colors hover:bg-secondary-hover whitespace-nowrap'
