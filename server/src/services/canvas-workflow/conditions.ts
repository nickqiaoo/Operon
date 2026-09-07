import type { CanvasCondition, CanvasConditionGroup } from '../../types/canvas-workflow.js'

const IDENTIFIER_PATH = /^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*|\[\d+\])*$/

function quote(value: string): string {
  return JSON.stringify(value)
}

function isNumeric(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Number(value))
}

/** Compile one row into a parenthesised nunjucks expression. */
export function compileConditionRow(row: CanvasCondition): string {
  const variable = row.variable.trim()
  if (!IDENTIFIER_PATH.test(variable)) {
    throw new Error(`invalid variable "${row.variable}" (use a name like review.passed)`)
  }
  const value = row.value ?? ''
  const literal = isNumeric(value) ? Number(value).toString() : quote(value)

  switch (row.operator) {
    case 'is_true': return `(${variable})`
    case 'is_false': return `(not ${variable})`
    case 'is_empty': return `(not ${variable})`
    case 'not_empty': return `(${variable})`
    case 'equals': return isNumeric(value) ? `(${variable} == ${literal})` : `((${variable} | string) == ${literal})`
    case 'not_equals': return isNumeric(value) ? `(${variable} != ${literal})` : `((${variable} | string) != ${literal})`
    case 'contains': return `(${quote(value)} in ((${variable} | string) if (${variable} is string) else (${variable} or [])))`
    case 'not_contains': return `(not (${quote(value)} in ((${variable} | string) if (${variable} is string) else (${variable} or []))))`
    case 'gt': return `((${variable} | float) > ${Number(value) || 0})`
    case 'gte': return `((${variable} | float) >= ${Number(value) || 0})`
    case 'lt': return `((${variable} | float) < ${Number(value) || 0})`
    case 'lte': return `((${variable} | float) <= ${Number(value) || 0})`
    case 'matches': return `((${variable} | string) | regex_test(${quote(value)}))`
    default:
      throw new Error(`unknown operator "${row.operator as string}"`)
  }
}

/**
 * The expression a condition group evaluates to. A written expression wins;
 * otherwise the rows are joined with the combinator. No rows and no
 * expression means "never", which is safer than "always" for a branch.
 */
export function compileConditionGroup(group: CanvasConditionGroup): string {
  const expression = group.expression?.trim()
  if (expression) return expression
  const rows = (group.conditions ?? []).filter((row) => row.variable.trim().length > 0)
  if (rows.length === 0) return 'false'
  const joiner = group.combinator === 'or' ? ' or ' : ' and '
  return rows.map(compileConditionRow).join(joiner)
}
