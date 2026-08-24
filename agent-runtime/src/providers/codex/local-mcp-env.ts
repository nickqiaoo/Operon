const LOCAL_MCP_NO_PROXY_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const

function mergeNoProxyValue(existing: string | undefined): string {
  const values = new Set(
    (existing ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )
  for (const host of LOCAL_MCP_NO_PROXY_HOSTS) values.add(host)
  return Array.from(values).join(',')
}

export function withLocalMcpNoProxy(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    NO_PROXY: mergeNoProxyValue(env.NO_PROXY),
    no_proxy: mergeNoProxyValue(env.no_proxy),
  }
}
