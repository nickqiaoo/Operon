export function toolEnvironment(part: object) {
  const meta = (part as { callProviderMetadata?: { operon?: { environment?: unknown; remote?: unknown } } }).callProviderMetadata?.operon;
  return typeof meta?.environment === 'string' ? { environment: meta.environment, remote: meta.remote === true } : undefined;
}
