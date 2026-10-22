import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

export interface OpencodeServer {
  url: string
  headers: Record<string, string>
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

/** Own an isolated V2 server and authenticate the client without logging its password. */
export function startOpencodeServer(options: StartOpencodeServerOptions): Promise<OpencodeServer> {
  const args = ['serve', `--hostname=${options.hostname}`, `--port=${options.port}`]
  const password = options.env.OPENCODE_PASSWORD || options.env.OPENCODE_SERVER_PASSWORD || randomBytes(32).toString('base64url')
  const proc = spawn(options.binary, args, {
    env: { ...options.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config) },
  })
  const stop = (): void => {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    proc.kill()
  }

  return new Promise<OpencodeServer>((resolve, reject) => {
    let output = ''
    let settled = false
    let url: string | undefined
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
        url ??= line.match(/^server listening on\s+(https?:\/\/[^\s]+)/)?.[1]
        if (!url) continue
        settled = true
        clearTimeout(timer)
        resolve({ url, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }, close: stop })
        return
      }
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    proc.on('exit', (code) => {
      const safeOutput = output.replace(/server password .*/g, 'server password [redacted]')
      fail(new Error(`Server exited with code ${code}${safeOutput.trim() ? `\nServer output: ${safeOutput}` : ''}`))
    })
    proc.on('error', (error) => fail(error))
  })
}
