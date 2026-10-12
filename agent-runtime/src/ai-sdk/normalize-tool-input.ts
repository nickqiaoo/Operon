const shouldAttemptJsonParse = (value: string): boolean => {
  const trimmed = value.trim()
  if (trimmed.length === 0) return false

  const firstChar = trimmed[0]
  if (firstChar === '{' || firstChar === '[' || firstChar === '"') return true
  if (trimmed === 'true' || trimmed === 'false' || trimmed === 'null') return true

  return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)
}

export const normalizeToolInput = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  if (!shouldAttemptJsonParse(value)) return value

  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}
