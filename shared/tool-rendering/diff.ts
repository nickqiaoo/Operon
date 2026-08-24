export interface DiffStats {
  additions: number
  deletions: number
}

export type PierreDiffThemeType = 'light' | 'dark' | 'system'
export type PierreDiffStyle = 'split' | 'unified'

export function ensureTrailingNewline(value: string): string {
  return value.length > 0 && !value.endsWith('\n') ? `${value}\n` : value
}

export function normalizeUnifiedPatch(path: string, content: string): string {
  const trimmed = content.trimStart()
  if (trimmed.startsWith('@@') || (!trimmed.startsWith('---') && !trimmed.startsWith('diff '))) {
    return `--- a/${path}\n+++ b/${path}\n${content}`
  }
  return content
}

export function getDiffStats(content: string): DiffStats {
  let additions = 0
  let deletions = 0

  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions += 1
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions += 1
    }
  }

  return { additions, deletions }
}

export function createPierreDiffOptions(
  themeType: PierreDiffThemeType,
  diffStyle: PierreDiffStyle = 'split',
) {
  return {
    diffStyle,
    diffIndicators: 'bars' as const,
    lineDiffType: 'none' as const,
    overflow: 'wrap' as const,
    themeType,
    theme: {
      light: 'pierre-light',
      dark: 'pierre-dark',
    },
  }
}

/**
 * Options for a pierre `<File>` (plain file preview). Shares the diff theme so
 * the file preview and the diff render in the same typeface/colors. The file
 * preview draws its own header, so pierre's is disabled.
 */
export function createPierreFileOptions(themeType: PierreDiffThemeType) {
  return {
    overflow: 'wrap' as const,
    themeType,
    disableFileHeader: true,
    theme: {
      light: 'pierre-light',
      dark: 'pierre-dark',
    },
  }
}
