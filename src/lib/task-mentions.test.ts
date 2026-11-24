import { describe, expect, it } from 'vitest'
import { taskNumbersIn } from './task-mentions'

describe('taskNumbersIn', () => {
  it('finds #Task N in order, once each, any case', () => {
    expect(taskNumbersIn('已补充看板任务 **#Task 25 remoteagent**，见 #task3 和 #TASK 25。')).toEqual([25, 3])
  })

  it('leaves bare #N alone', () => {
    expect(taskNumbersIn('PR #12, step #3, task #25')).toEqual([])
  })

  it('ignores glued text, URLs, trailing letters and code', () => {
    expect(taskNumbersIn('abc#Task 4 https://x.dev/a#Task5 #Task 6a `#Task 7` ```\n#Task 8\n```')).toEqual([])
  })

  it('accepts punctuation around it', () => {
    expect(taskNumbersIn('(#Task 9), #Task 10.')).toEqual([9, 10])
  })
})
