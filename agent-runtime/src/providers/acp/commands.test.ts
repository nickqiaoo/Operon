import { describe, expect, it } from 'vitest'
import type * as acp from '@zed-industries/agent-client-protocol'
import { toSlashCommands } from './commands.js'
import type { AcpProviderConfig } from './types.js'

const config = (classifyCommand?: AcpProviderConfig['classifyCommand']) =>
  ({ classifyCommand }) as AcpProviderConfig

const cmd = (name: string, extra: Partial<acp.AvailableCommand> = {}) =>
  ({ name, description: `${name} desc`, ...extra }) as acp.AvailableCommand

describe('toSlashCommands', () => {
  it('maps the protocol fields and defaults to plain commands', () => {
    expect(toSlashCommands(config(), [cmd('compact')])).toEqual([
      { name: 'compact', description: 'compact desc', type: 'command' },
    ])
  })

  it('delegates the skill split to the provider', () => {
    const classify = (c: acp.AvailableCommand) => (c.name === 'review' ? 'skill' : 'command')
    expect(toSlashCommands(config(classify), [cmd('review'), cmd('compact')])).toEqual([
      { name: 'review', description: 'review desc', type: 'skill' },
      { name: 'compact', description: 'compact desc', type: 'command' },
    ])
  })

  it('drops nameless and duplicate entries, keeping the first', () => {
    const items = toSlashCommands(config(), [
      cmd('dup', { description: 'first' }),
      cmd('dup', { description: 'second' }),
      cmd('  '),
      cmd('spaced  '),
    ])
    expect(items).toEqual([
      { name: 'dup', description: 'first', type: 'command' },
      { name: 'spaced', description: 'spaced   desc', type: 'command' },
    ])
  })

  it('treats an absent push as no commands, not as an empty menu', () => {
    // buildAcpDescriptor distinguishes these: [] means "fall back to the static
    // list", so a provider that was never probed must not look like one with
    // genuinely zero commands.
    expect(toSlashCommands(config(), null)).toEqual([])
    expect(toSlashCommands(config(), undefined)).toEqual([])
  })
})
