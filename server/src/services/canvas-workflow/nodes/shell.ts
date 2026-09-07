import { spawn } from 'node:child_process'
import path from 'node:path'
import type { CanvasNode, CanvasShellNodeData } from '../../../types/canvas-workflow.js'
import { DEFAULT_NODE_TIMEOUT_MS } from '../limits.js'
import type { NodeExecutorDefinition } from '../types.js'

const STDERR_PREVIEW_CHARS = 2048

function resolveCwd(root: string, cwd: string | undefined): string {
  const trimmed = cwd?.trim()
  if (!trimmed) return root
  return path.isAbsolute(trimmed) ? trimmed : path.join(root, trimmed)
}

/**
 * Run a shell command in the workspace. stdout is the output; stderr rides
 * along only when the node is configured to tolerate a non-zero exit, so a
 * downstream template never has to strip diagnostics out of real output.
 */
export const shellNode: NodeExecutorDefinition = {
  timeoutMs: (node: CanvasNode) =>
    (node.data as CanvasShellNodeData).timeoutMs ?? DEFAULT_NODE_TIMEOUT_MS,

  execute: (ctx) => {
    const data = ctx.node.data as CanvasShellNodeData
    const command = ctx.render(data.command ?? '').trim()
    if (command.length === 0) throw new Error('shell failed: command is empty')

    const failOnNonZero = data.failOnNonZero ?? true
    const cwd = resolveCwd(ctx.cwd, data.cwd)

    return new Promise<string>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd,
        env: process.env,
        signal: ctx.signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
      child.stderr.on('data', (chunk: string) => { stderr += chunk })

      child.on('error', (error) => {
        reject(new Error(`shell failed: ${error.message}`))
      })

      child.on('close', (code, signal) => {
        if (signal) {
          reject(new Error(`shell failed: killed by ${signal}`))
          return
        }
        if (code !== 0 && failOnNonZero) {
          const preview = stderr.trim().slice(0, STDERR_PREVIEW_CHARS)
          reject(new Error(`shell failed: exit code ${code}${preview ? `\n${preview}` : ''}`))
          return
        }
        if (code !== 0 && stderr.trim().length > 0) {
          resolve(`${stdout}\n[stderr]\n${stderr}`)
          return
        }
        resolve(stdout)
      })
    })
  },
}
