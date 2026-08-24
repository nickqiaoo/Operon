import { describe, it, expect } from 'vitest'
import { parsePlanTasks, planWaves } from './sdd-service.js'

describe('parsePlanTasks — coordination groups', () => {
  it('splits a Markdown plan heading into a plain title and Markdown description', () => {
    const [row] = parsePlanTasks(
      '- [ ] [T001] [C1] [AC-1, AC-2] **Subtask A — contract owner.** Create `shared-contract.json` and propose a `status` value.',
    )

    expect(row).toMatchObject({
      anchor: 'T001',
      title: 'Subtask A — contract owner.',
      description: 'Create `shared-contract.json` and propose a `status` value.',
    })
  })

  it('parses [C<n>] alongside [P] and [AC-n], and keeps it out of the title', () => {
    const [row] = parsePlanTasks(
      '- [ ] T2 [P] [C1] [AC-2] Server-side key issuance and bearer auth',
    )
    expect(row).toMatchObject({
      anchor: 'T2',
      parallel: true,
      coordGroup: 'C1',
      claimedAcs: ['AC-2'],
      title: 'Server-side key issuance and bearer auth',
      description: '',
    })
  })

  it('defaults coordGroup to null when the row carries no [C] tag', () => {
    const [row] = parsePlanTasks('- [ ] T4 [AC-4] Docs and integration tests')
    expect(row.coordGroup).toBeNull()
    expect(row.parallel).toBe(false)
  })

  it('groups rows sharing a tag and separates distinct ones', () => {
    const rows = parsePlanTasks(
      [
        '- [ ] T1 [C1] server',
        '- [ ] T2 [C1] ui',
        '- [ ] T3 [C2] worker',
        '- [ ] T4 docs',
      ].join('\n'),
    )
    expect(rows.map((r) => r.coordGroup)).toEqual(['C1', 'C1', 'C2', null])
  })

  it('is case-insensitive and does not confuse [C1] with an anchor or an AC', () => {
    const [row] = parsePlanTasks('- [ ] [T12] [c3] [AC-1] migrate schema')
    expect(row).toMatchObject({ anchor: 'T12', coordGroup: 'C3', claimedAcs: ['AC-1'] })
  })

  it('ignores bracket groups that merely start with C', () => {
    const [row] = parsePlanTasks('- [ ] T7 [CLI] add the command')
    expect(row.coordGroup).toBeNull()
    expect(row.title).toBe('add the command')
  })
})

describe('planWaves — [P] scheduling', () => {
  const waves = (plan: string) => planWaves(parsePlanTasks(plan))

  it('runs an un-tagged row alone and starts the following [P] rows as one wave', () => {
    expect(
      waves(
        [
          '- [ ] T1 [AC-1] define the shared type',
          '- [ ] T2 [P] [AC-2] server endpoint',
          '- [ ] T3 [P] [AC-2] client fetch',
          '- [ ] T4 [AC-4] docs over the finished endpoint',
        ].join('\n'),
      ),
    ).toEqual([['T1'], ['T2', 'T3'], ['T4']])
  })

  it('lets a plan open with a parallel wave', () => {
    expect(waves(['- [ ] T1 [P] a', '- [ ] T2 [P] b', '- [ ] T3 c'].join('\n'))).toEqual([
      ['T1', 'T2'],
      ['T3'],
    ])
  })

  it('treats every un-tagged row as its own barrier', () => {
    expect(waves(['- [ ] T1 a', '- [ ] T2 b', '- [ ] T3 c'].join('\n'))).toEqual([
      ['T1'],
      ['T2'],
      ['T3'],
    ])
  })

  it('reopens a parallel wave after a barrier splits it', () => {
    expect(
      waves(
        ['- [ ] T1 [P] a', '- [ ] T2 b', '- [ ] T3 [P] c', '- [ ] T4 [P] d'].join('\n'),
      ),
    ).toEqual([['T1'], ['T2'], ['T3', 'T4']])
  })

  it('is empty for a plan with no task rows', () => {
    expect(waves('## Tasks\n\nnothing anchored here')).toEqual([])
  })
})

describe('planWaves — [C<n>] implies [P]', () => {
  const waves = (plan: string) => planWaves(parsePlanTasks(plan))

  it('runs a coordination group concurrently without needing an explicit [P]', () => {
    expect(
      waves(
        [
          '- [ ] T1 [AC-1] define the shared response shape',
          '- [ ] T2 [C1] [AC-2] server-side issuance',
          '- [ ] T3 [C1] [AC-2] management UI',
        ].join('\n'),
      ),
    ).toEqual([['T1'], ['T2', 'T3']])
  })

  it('merges [P] and [C1] rows that sit next to each other', () => {
    expect(waves(['- [ ] T1 [P] a', '- [ ] T2 [C1] b', '- [ ] T3 [C1] c'].join('\n'))).toEqual([
      ['T1', 'T2', 'T3'],
    ])
  })

  it('still splits a group that a bare row sits between (decompose then drops it)', () => {
    expect(waves(['- [ ] T1 [C1] a', '- [ ] T2 barrier', '- [ ] T3 [C1] c'].join('\n'))).toEqual([
      ['T1'],
      ['T2'],
      ['T3'],
    ])
  })
})
