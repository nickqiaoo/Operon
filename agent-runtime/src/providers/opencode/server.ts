import { spawn } from 'node:child_process'

export interface OpencodeServer {
  url: string
  close(): void
}

export interface StartOpencodeServerOptions {
  /** The `opencode` executable — a resolved path, or the bare name for a PATH lookup. */
  binary: string
  env: Record<string, string>
  hostname: string
  port: number
  timeout: number
  /** Passed as `OPENCODE_CONFIG_CONTENT`, which OpenCode merges over the user's own config. */
  config: Record<string, unknown>
}

/**
 * `opencode serve`, started the way `@opencode-ai/sdk`'s `createOpencodeServer`
 * does it, but with the executable and environment supplied by the caller. The
 * SDK's version always spawns the bare `opencode` with `process.env`, which left
 * us patching the global PATH and env before every call — wrong for a library,
 * where the embedding app's process environment is not ours to rewrite.
 */
export function startOpencodeServer(options: StartOpencodeServerOptions): Promise<OpencodeServer> {
  const args = ['serve', `--hostname=${options.hostname}`, `--port=${options.port}`]
  const proc = spawn(options.binary, args, {
    env: { ...options.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config) },
  })
  const stop = (): void => {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    proc.kill()
  }

  return new Promise<OpencodeServer>((resolve, reject) => {
    let output = ''
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stop()
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new Error(`Timeout waiting for server to start after ${options.timeout}ms`))
    }, options.timeout)

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      output += chunk.toString()
      for (const line of output.split('\n')) {
        if (!line.startsWith('opencode server listening')) continue
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
        if (!match) {
          fail(new Error(`Failed to parse server url from output: ${line}`))
          return
        }
        settled = true
        clearTimeout(timer)
        resolve({ url: match[1], close: stop })
        return
      }
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    proc.on('exit', (code) => {
      fail(new Error(`Server exited with code ${code}${output.trim() ? `\nServer output: ${output}` : ''}`))
    })
    proc.on('error', (error) => fail(error))
  })
}
