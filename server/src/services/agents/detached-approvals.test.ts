/**
 * The detached sub-agent approval bridge — the paths that decide whether an
 * unattended sub-agent finishes or wedges forever.
 *
 * Before this bridge existed, an approval from a standalone session reached
 * nobody and its provider promise never settled, hanging the sub-agent and its
 * concurrency slot until the whole run was aborted. Each case below covers one
 * way out of that state, so a regression shows up as a hang here rather than in
 * a live workflow.
 *
 * The inbox side-effect is exercised for real (not stubbed): with no notification
 * storage registered in a test process, `observeApprovalPart` returns before
 * touching it, which also proves surfacing can't throw into the stream watcher.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { PermissionDecision, RuntimeSession, RuntimeStreamPart } from '@operon/agent-runtime'
import {
  watchDetachedApprovals,
  resolveDetachedApproval,
  resetDetachedApprovals,
  APPROVAL_TIMEOUT_MS,
  type DetachedApprovalRequest,
} from './detached-approvals.js'

afterEach(() => {
  resetDetachedApprovals()
  vi.useRealTimers()
})

/** Minimal session that records what the bridge hands back to the provider. */
function fakeSession(): RuntimeSession & { decisions: Array<{ id: string; decision: PermissionDecision }> } {
  const decisions: Array<{ id: string; decision: PermissionDecision }> = []
  return {
    decisions,
    // eslint-disable-next-line require-yield
    async *stream() {},
    abort() {},
    async dispose() {},
    resolvePermission(approvalId: string, decision: PermissionDecision) {
      decisions.push({ id: approvalId, decision })
    },
  } as unknown as RuntimeSession & { decisions: Array<{ id: string; decision: PermissionDecision }> }
}

function approvalPart(approvalId: string, toolName = 'Bash'): RuntimeStreamPart {
  return {
    type: 'tool-approval-request',
    approvalId,
    toolCall: { type: 'tool-call', toolCallId: `tc-${approvalId}`, toolName, input: {}, dynamic: true },
  } as unknown as RuntimeStreamPart
}

describe('detached sub-agent approvals', () => {
  it('denies an unanswered request once the timeout elapses', () => {
    vi.useFakeTimers()
    const session = fakeSession()
    const { onPart } = watchDetachedApprovals({ session, parentChatId: 7, agentId: 'codex-a1' })

    onPart(approvalPart('ap-1'))
    expect(session.decisions).toHaveLength(0) // still waiting on a human

    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS)

    expect(session.decisions).toHaveLength(1)
    expect(session.decisions[0]!.id).toBe('ap-1')
    expect(session.decisions[0]!.decision.type).toBe('deny')
    // The sub-agent must be told WHY, so it can report the gap instead of just failing.
    expect((session.decisions[0]!.decision as { reason?: string }).reason).toMatch(/unattended/i)
  })

  it('forwards a human decision to the sub-agent session', () => {
    vi.useFakeTimers()
    const session = fakeSession()
    const { onPart } = watchDetachedApprovals({ session, parentChatId: 7, agentId: 'codex-a1' })
    onPart(approvalPart('ap-2'))

    expect(resolveDetachedApproval(7, 'ap-2', { type: 'allow' })).toBe(true)
    expect(session.decisions).toEqual([{ id: 'ap-2', decision: { type: 'allow' } }])

    // Answering must cancel the timer, or the allow would be followed by a deny.
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS * 2)
    expect(session.decisions).toHaveLength(1)
  })

  it('refuses a decision from a different conversation', () => {
    const session = fakeSession()
    const { onPart } = watchDetachedApprovals({ session, parentChatId: 7, agentId: 'codex-a1' })
    onPart(approvalPart('ap-3'))

    expect(resolveDetachedApproval(99, 'ap-3', { type: 'allow' })).toBe(false)
    expect(session.decisions).toHaveLength(0)
    // Still answerable by the conversation that actually launched it.
    expect(resolveDetachedApproval(7, 'ap-3', { type: 'allow' })).toBe(true)
  })

  it('returns false for an id it does not own, so chat sessions still resolve', () => {
    expect(resolveDetachedApproval(7, 'not-ours', { type: 'allow' })).toBe(false)
  })

  it('denies anything still outstanding when the sub-agent ends', () => {
    const session = fakeSession()
    const { onPart, dispose } = watchDetachedApprovals({ session, parentChatId: 7, agentId: 'codex-a1' })
    onPart(approvalPart('ap-4'))
    onPart(approvalPart('ap-5', 'Write'))

    dispose()

    expect(session.decisions.map((d) => d.id)).toEqual(['ap-4', 'ap-5'])
    expect(session.decisions.every((d) => d.decision.type === 'deny')).toBe(true)
    // And the entries are gone — a late answer must not re-settle them.
    expect(resolveDetachedApproval(7, 'ap-4', { type: 'allow' })).toBe(false)
  })

  it('survives a session that throws on resolvePermission', () => {
    const session = {
      ...fakeSession(),
      resolvePermission() {
        throw new Error('session already disposed')
      },
    } as unknown as RuntimeSession
    const { onPart, dispose } = watchDetachedApprovals({ session, parentChatId: 7, agentId: 'codex-a1' })
    onPart(approvalPart('ap-6'))

    expect(() => dispose()).not.toThrow()
  })

  it('declines a plan review immediately — a sub-agent was never asked to plan', () => {
    vi.useFakeTimers()
    const session = fakeSession()
    const { onPart } = watchDetachedApprovals({ session, parentChatId: 7, agentId: 'codex-a1' })

    onPart(approvalPart('ap-plan', 'ExitPlanMode'))

    // Refused on the spot, not after the timeout — sub-agents run in execution
    // modes, so this is a model mistake, and "just do the work" is the answer.
    expect(session.decisions).toHaveLength(1)
    expect(session.decisions[0]!.decision.type).toBe('deny')
    expect((session.decisions[0]!.decision as { reason?: string }).reason).toMatch(
      /carry out the task directly/i,
    )

    // Nothing was parked, so nothing can settle it twice.
    expect(resolveDetachedApproval(7, 'ap-plan', { type: 'allow' })).toBe(false)
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS * 2)
    expect(session.decisions).toHaveLength(1)
  })

  it('forwards a question and delivers the typed answers back', () => {
    const session = fakeSession()
    const { onPart } = watchDetachedApprovals({ session, parentChatId: 7, agentId: 'codex-a1' })

    // A question is NOT refused: the launching conversation exists, and its inbox
    // can carry both the question and the answer.
    onPart(approvalPart('ap-ask', 'AskUserQuestion'))
    expect(session.decisions).toHaveLength(0)

    const answers = { 'Which database?': 'Postgres' }
    expect(
      resolveDetachedApproval(7, 'ap-ask', { type: 'allow', updatedInput: { answers } }),
    ).toBe(true)
    expect(session.decisions[0]!.decision).toEqual({ type: 'allow', updatedInput: { answers } })
  })

  it('pairs a question with the options from its tool-call', () => {
    const session = fakeSession()
    const surfaced: DetachedApprovalRequest[] = []
    const { onPart } = watchDetachedApprovals({
      session,
      parentChatId: 7,
      agentId: 'codex-a1',
      // The display needs the questions themselves; the approval part carries an
      // empty input, so they have to come from the earlier tool-call part.
      onRequest: (request) => surfaced.push(request),
    })

    const questions = [{ question: 'Which database?', header: 'DB', options: [{ label: 'Postgres' }] }]
    onPart({
      type: 'tool-call',
      toolCallId: 'tc-ap-ask2',
      toolName: 'AskUserQuestion',
      input: { questions },
    } as unknown as RuntimeStreamPart)
    onPart(approvalPart('ap-ask2', 'AskUserQuestion'))

    expect(surfaced).toHaveLength(1)
    expect(surfaced[0]!.toolInput).toEqual({ questions })
    // The run card labels the request with the sub-agent that is blocked on it.
    expect(surfaced[0]!.agentId).toBe('codex-a1')
    expect(surfaced[0]!.toolName).toBe('AskUserQuestion')
  })

  it('tells the display when a request is settled, however it settled', () => {
    vi.useFakeTimers()
    const session = fakeSession()
    const settled: string[] = []
    const { onPart, dispose } = watchDetachedApprovals({
      session,
      parentChatId: 7,
      agentId: 'codex-a1',
      onSettled: (approvalId) => settled.push(approvalId),
    })

    onPart(approvalPart('ap-answered'))
    onPart(approvalPart('ap-timeout'))
    onPart(approvalPart('ap-ended'))

    resolveDetachedApproval(7, 'ap-answered', { type: 'allow' })
    expect(settled).toEqual(['ap-answered'])

    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS)
    expect(settled).toContain('ap-timeout')

    dispose()
    // Every surface must be cleared for all three, or the run card keeps asking
    // for a decision that no longer exists.
    expect(settled).toEqual(['ap-answered', 'ap-timeout', 'ap-ended'])
  })

  it('ignores non-approval parts', () => {
    const session = fakeSession()
    const { onPart } = watchDetachedApprovals({ session, parentChatId: 7, agentId: 'codex-a1' })

    onPart({ type: 'text-delta', id: 't1', text: 'hi' } as unknown as RuntimeStreamPart)
    onPart({ type: 'finish' } as unknown as RuntimeStreamPart)

    expect(resolveDetachedApproval(7, 'ap-none', { type: 'allow' })).toBe(false)
    expect(session.decisions).toHaveLength(0)
  })

  it('still settles when there is no launching conversation', () => {
    vi.useFakeTimers()
    const session = fakeSession()
    // chatId 0 = no inbox to surface into; the timeout must still fire.
    const { onPart } = watchDetachedApprovals({ session, parentChatId: null, agentId: 'custom-a1' })
    onPart(approvalPart('ap-7'))

    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS)
    expect(session.decisions).toHaveLength(1)
    expect(session.decisions[0]!.decision.type).toBe('deny')
  })
})
