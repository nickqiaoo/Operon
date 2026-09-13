import { describe, expect, it } from 'vitest'
import { fromLinearPriority, pickLinearState, statusOfLinearState, toLinearPriority } from './linear-mapping.js'
import type { TaskPriority } from '../../types/task.js'

const states = [
  { id: 'bl', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 'td', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 'ip', name: 'In Progress', type: 'started', position: 2 },
  { id: 'ir', name: 'In Review', type: 'started', position: 3 },
  { id: 'dn', name: 'Done', type: 'completed', position: 4 },
  { id: 'cx', name: 'Canceled', type: 'canceled', position: 5 },
]

describe('priority', () => {
  it('round-trips: operon 4=urgent is Linear 1=urgent, none stays none', () => {
    for (const p of [0, 1, 2, 3, 4] as TaskPriority[]) expect(fromLinearPriority(toLinearPriority(p))).toBe(p)
    expect(toLinearPriority(4)).toBe(1)
    expect(toLinearPriority(1)).toBe(4)
    expect(fromLinearPriority(null)).toBe(0)
    expect(fromLinearPriority(9)).toBe(0)
  })
})

describe('workflow state', () => {
  it('maps task status to the team state by type, review by name', () => {
    expect(pickLinearState(states, 'todo')?.id).toBe('td')
    expect(pickLinearState(states, 'in_progress')?.id).toBe('ip')
    expect(pickLinearState(states, 'in_review')?.id).toBe('ir')
    expect(pickLinearState(states, 'done')?.id).toBe('dn')
    expect(pickLinearState(states, 'cancelled')?.id).toBe('cx')
  })

  it('falls back to backlog for todo and to any started state when no review column exists', () => {
    const noTodo = states.filter((s) => s.id !== 'td')
    expect(pickLinearState(noTodo, 'todo')?.id).toBe('bl')
    const noReview = states.filter((s) => s.id !== 'ir')
    expect(pickLinearState(noReview, 'in_review')).toBeNull()
    expect(pickLinearState(noReview, 'in_progress')?.id).toBe('ip')
  })

  it('maps a Linear state back to a task status, and each direction agrees', () => {
    expect(statusOfLinearState({ type: 'unstarted', name: 'Todo' })).toBe('todo')
    expect(statusOfLinearState({ type: 'started', name: 'In Review' })).toBe('in_review')
    expect(statusOfLinearState({ type: 'started', name: 'In Progress' })).toBe('in_progress')
    expect(statusOfLinearState({ type: 'completed', name: 'Done' })).toBe('done')
    expect(statusOfLinearState({ type: 'canceled', name: 'Canceled' })).toBe('cancelled')
    expect(statusOfLinearState({ type: 'weird', name: 'x' })).toBeNull()
    for (const status of ['todo', 'in_progress', 'in_review', 'done', 'cancelled'] as const) {
      const st = pickLinearState(states, status)
      expect(st && statusOfLinearState(st)).toBe(status)
    }
  })
})
