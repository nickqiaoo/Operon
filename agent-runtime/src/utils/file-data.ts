/**
 * AI SDK 7 wraps file payloads in tagged `data` / `url` objects. Provider
 * adapters also accept the older bare payloads. Keep provider references
 * untouched so adapters report them as unsupported instead of treating an ID
 * as image bytes.
 */
export function unwrapFileData(input: unknown): unknown {
  let value = input
  if (value && typeof value === 'object' && 'type' in value) {
    if (value.type === 'data' && 'data' in value) value = value.data
    else if (value.type === 'url' && 'url' in value) value = value.url
  }
  // Inline URLs contain the bytes; adapters must not send them as file links.
  if (value instanceof URL && value.protocol === 'data:') return value.href
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return value
}
