import { describe, expect, it } from 'vitest'
import { addedFacts } from './files.js'

describe('addedFacts', () => {
  it('reads what an edit added as the user would: no bullet, no date', () => {
    const before = '# About the user\n- 2026-10-11：用 Grafana Cloud 监控 Operon Broker\n\n# People\n'
    const after = '# About the user\n- 2026-10-11：用 Grafana Cloud 监控 Operon Broker\n- 2026-10-12: 开特斯拉 Model 3\n\n# People\n* 老婆：小李\n'
    expect(addedFacts(before, after)).toEqual(['开特斯拉 Model 3', '老婆：小李'])
  })
  it('ignores headings, removals and lines merely moved', () => {
    expect(addedFacts('# A\n- x\n- y\n', '# B\n- y\n- x\n')).toEqual([])
    expect(addedFacts('- x\n- y\n', '- x\n')).toEqual([])
  })
})
