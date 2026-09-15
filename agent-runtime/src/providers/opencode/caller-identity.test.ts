import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  bindOpencodeCaller,
  OPENCODE_CALLER_ARG,
  OPENCODE_CALLER_PLUGIN_SOURCE,
  resolveOpencodeCaller,
  stripOpencodeCallerArg,
  unbindOpencodeCaller,
} from './caller-identity.js'

type BeforeHook = (input: { tool: string; sessionID: string; callID: string }, output: { args: Record<string, unknown> }) => Promise<void>

async function loadPlugin(parents: Record<string, string | undefined>, failing = new Set<string>()) {
  const dir = mkdtempSync(path.join(tmpdir(), 'operon-caller-plugin-'))
  const file = path.join(dir, 'plugin.mjs')
  writeFileSync(file, OPENCODE_CALLER_PLUGIN_SOURCE)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
  // OpenCode's legacy loader calls every export, so there must be exactly one function.
  expect(Object.keys(mod)).toEqual(['OperonCallerIdentity'])
  const server = mod.OperonCallerIdentity as (input: unknown) => Promise<Record<string, BeforeHook>>
  const lookups: string[] = []
  const client = {
    session: {
      get: async ({ path: { id } }: { path: { id: string } }) => {
        lookups.push(id)
        if (failing.has(id)) throw new Error('unavailable')
        return { data: { id, parentID: parents[id] } }
      },
    },
  }
  const hooks = await server({ client })
  return { before: hooks['tool.execute.before'], lookups }
}

describe('OpenCode caller identity plugin', () => {
  it('tags only first-party routed tools, in place', async () => {
    const { before } = await loadPlugin({})

    const args: Record<string, unknown> = { prompt: 'x' }
    const output = { args }
    await before({ tool: 'external_agent_external_agent_run', sessionID: 'ses_a', callID: '1' }, output)
    expect(args[OPENCODE_CALLER_ARG]).toBe('ses_a')

    const workflow = { args: {} as Record<string, unknown> }
    await before({ tool: 'workflow_OperonWorkflow', sessionID: 'ses_a', callID: '2' }, workflow)
    expect(workflow.args[OPENCODE_CALLER_ARG]).toBe('ses_a')

    const other = { args: {} as Record<string, unknown> }
    await before({ tool: 'github_create_issue', sessionID: 'ses_a', callID: '3' }, other)
    await before({ tool: 'bash', sessionID: 'ses_a', callID: '4' }, other)
    expect(other.args).toEqual({})
  })

  it('reports a sub-agent call as its root session and caches the walk', async () => {
    const { before, lookups } = await loadPlugin({ ses_grandchild: 'ses_child', ses_child: 'ses_root' })
    const output = { args: {} as Record<string, unknown> }
    await before({ tool: 'external_agent_external_agent_run', sessionID: 'ses_grandchild', callID: '1' }, output)
    expect(output.args[OPENCODE_CALLER_ARG]).toBe('ses_root')

    lookups.length = 0
    const again = { args: {} as Record<string, unknown> }
    await before({ tool: 'external_agent_external_agent_send', sessionID: 'ses_child', callID: '2' }, again)
    expect(again.args[OPENCODE_CALLER_ARG]).toBe('ses_root')
    expect(lookups).toEqual([])
  })

  it('does not cache a failed lookup', async () => {
    const failing = new Set(['ses_child'])
    const { before, lookups } = await loadPlugin({ ses_child: 'ses_root' }, failing)
    const first = { args: {} as Record<string, unknown> }
    await before({ tool: 'workflow_OperonWorkflow', sessionID: 'ses_child', callID: '1' }, first)
    expect(first.args[OPENCODE_CALLER_ARG]).toBe('ses_child')

    failing.clear()
    const second = { args: {} as Record<string, unknown> }
    await before({ tool: 'workflow_OperonWorkflow', sessionID: 'ses_child', callID: '2' }, second)
    expect(second.args[OPENCODE_CALLER_ARG]).toBe('ses_root')
    expect(lookups).toEqual(['ses_child', 'ses_child', 'ses_root'])
  })
})

describe('OpenCode caller map', () => {
  it('keeps a binding that a different conversation took over', () => {
    bindOpencodeCaller('ses_1', '101')
    bindOpencodeCaller('ses_2', '202')
    expect(resolveOpencodeCaller('ses_1')).toBe('101')
    expect(resolveOpencodeCaller('ses_2')).toBe('202')

    bindOpencodeCaller('ses_1', '303')
    unbindOpencodeCaller('ses_1', '101')
    expect(resolveOpencodeCaller('ses_1')).toBe('303')
    unbindOpencodeCaller('ses_1', '303')
    expect(resolveOpencodeCaller('ses_1')).toBeUndefined()
  })

  it('hides the argument from transcript input', () => {
    expect(stripOpencodeCallerArg({ prompt: 'x', [OPENCODE_CALLER_ARG]: 'ses_1' })).toEqual({ prompt: 'x' })
    expect(stripOpencodeCallerArg({ prompt: 'x' })).toEqual({ prompt: 'x' })
    expect(stripOpencodeCallerArg(undefined)).toBeUndefined()
  })
})
