export interface PlanTaskText {
  title: string
  description: string
}

function plainInlineText(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

/**
 * A plan row may use a leading bold phrase as its short task title, followed by
 * Markdown instructions. Titles are stored as plain text; the remainder belongs
 * in the Markdown-capable task description.
 */
export function splitPlanTaskText(value: string): PlanTaskText {
  const text = value.trim()
  const leadingTitle = text.match(/^(?:\*\*(.+?)\*\*|__(.+?)__)\s*(.*)$/)
  if (!leadingTitle) {
    return { title: plainInlineText(text), description: '' }
  }

  return {
    title: plainInlineText(leadingTitle[1] ?? leadingTitle[2] ?? text),
    description: (leadingTitle[3] ?? '').trim(),
  }
}
