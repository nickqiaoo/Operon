/**
 * The review stage of a spec: ⑥ Review, once every ticket is merged.
 *
 *   reviewing        — two reviewers from different families review the whole
 *                      change against its base, checking every acceptance
 *                      criterion with evidence → the lead merges them into one
 *                      verdict in four piles (act on / consider / noted / dismissed)
 *   (act on?)        — one "Review fixes" ticket, built and reviewed like any
 *                      other; once it lands the lead re-checks only the fix
 *   awaiting_signoff — review.md is written; gate 2 waits for the user
 *
 * Like the design stage, each step is idempotent on the change branch: a
 * reviewer whose `reviews/<provider>.json` exists is not run again, and
 * `review.json` without `review.md` means a fix round is out. The agents are
 * recorded in the spec's workflow run through the build stage's session, and
 * gate 2 is reported back to the chat that started the spec.
 */

import type { Task } from '../../types/task.js'
import type { SpecReviewSummary, SpecRunConfig, SpecStage, SpecTicket, SpecTicketBuild } from '../../types/spec.js'
import { getCurrentBranch, getDiffStatText, getFileDiffRange, getHeadSha, getMergeBase } from '../git.js'
import { broadcastTask } from '../task-events.js'
import type { SpecAgents } from './agents.js'
import { addTicket, advance, notifySpec, sessionFor, type BuildStorage } from './build-run.js'
import { familyOf, seatFor } from './config.js'
import { SPEC_FILES, branchReviewFile, readSpecFile, readSpecJson, writeSpecFiles, type SpecLocation } from './files.js'
import {
  BRANCH_REVIEW_SCHEMA,
  SPEC_REVIEW_SCHEMA,
  branchReviewPrompt,
  consolidateReviewPrompt,
  recheckPrompt,
  renderReview,
  reviewFixesTicket,
  signoffNext,
  type BranchReviewResult,
  type SpecReview,
} from './prompts.js'

/** review.json on disk: the consolidated review plus what it was taken against. */
interface StoredReview extends SpecReview {
  /** Change-branch head the review read; a fix round's diff starts here. */
  head: string
  /** The branch the change merges into. */
  base: string
  /** Act-on items when the review was taken, before any fix round. */
  actOnBefore: number
}

/** Specs whose review stage is executing in this process. */
const running = new Set<number>()

/**
 * Two reviewers from different families, out of the providers the spec already
 * works with — the judge's and the builder-check's families first, since they
 * were picked to differ from the lead. One reviewer when the spec has only one family.
 */
export function branchReviewers(config: SpecRunConfig): string[] {
  const order = [config.judge, config.builder, ...config.candidates, config.lead, config.explorer].map((s) => s.providerId)
  const picked: string[] = []
  for (const id of order) {
    if (picked.length === 2) break
    if (!picked.includes(id) && !picked.some((p) => familyOf(p) === familyOf(id))) picked.push(id)
  }
  return picked
}

/** Every ticket was reviewed by a family other than its implementer's — not so in a spec limited to one agent. */
export function crossFamilyReviewed(build: readonly Pick<SpecTicketBuild, 'implementer' | 'reviewer'>[]): boolean {
  return build.every((b) => familyOf(b.implementer) !== familyOf(b.reviewer))
}

function locate(storage: BuildStorage, spec: Task): SpecLocation {
  const ws = spec.workspaceId != null ? storage.getWorkspace(spec.workspaceId) : null
  if (!ws) throw new Error(`spec #${spec.number} has lost its change worktree`)
  return { taskId: spec.id, taskNumber: spec.number, worktreePath: ws.worktreePath }
}

function setStage(storage: BuildStorage, specId: number, stage: SpecStage, error: string | null = null): void {
  storage.specRunUpdate(specId, { stage, error })
  broadcastTask(storage, specId)
}

/**
 * Every ticket is merged. Review the change — or, when a fix round just
 * landed, check the fix. Runs in the background; returns at once.
 */
export function onAllTicketsMerged(storage: BuildStorage, specId: number): void {
  const spec = storage.taskGet(specId)
  if (!spec || running.has(specId)) return
  running.add(specId)
  setStage(storage, specId, 'reviewing')
  const session = sessionFor(storage, spec)
  void session
    .run(async (agents) => {
      const loc = locate(storage, spec)
      const stored = await readSpecJson<StoredReview>(loc, SPEC_FILES.reviewJson)
      const final = await readSpecFile(loc, SPEC_FILES.review)
      const gate = stored && !final ? await recheck(storage, agents, spec, loc, stored) : await review(storage, agents, spec, loc)
      // Inside the run: the segment settles (and reports) as soon as it returns.
      if (gate) session.deliver(gate)
    })
    .catch((err) => {
      const reason = err instanceof Error ? err.message : String(err)
      if (session.stopped) {
        setStage(storage, specId, 'stopped')
        return
      }
      setStage(storage, specId, 'failed', `The review stopped with an error: ${reason}`)
      storage.taskAppendActivity(specId, {
        kind: 'system',
        actorType: 'system',
        actorName: 'OperonSpec',
        body: `The whole-change review stopped with an error: ${reason}`,
      })
    })
    .finally(() => running.delete(specId))
}

export function isReviewActive(specId: number): boolean {
  return running.has(specId)
}

/** What the run hands back to the chat at gate 2. */
interface GateResult {
  operonSpec: { task: number; stage: 'awaiting_signoff'; next: string }
}

async function changeDiff(storage: BuildStorage, spec: Task, loc: SpecLocation, from?: string) {
  const project = storage.getProject(spec.projectId)
  const base = (project ? await getCurrentBranch(project.rootPath) : null) ?? 'main'
  const head = await getHeadSha(loc.worktreePath)
  const start = from ?? (await getMergeBase(loc.worktreePath, base))
  if (!head || !start) throw new Error(`spec #${spec.number}'s change branch shares no history with ${base}`)
  const [diff, stat] = await Promise.all([
    getFileDiffRange(loc.worktreePath, undefined, start, head),
    getDiffStatText(loc.worktreePath, start, head),
  ])
  return { base, head, diff, stat }
}

async function review(
  storage: BuildStorage,
  agents: SpecAgents,
  spec: Task,
  loc: SpecLocation,
): Promise<GateResult | null> {
  const run = storage.specRunGet(spec.id)
  if (!run) return null
  const [brief, design, tickets] = await Promise.all([
    readSpecFile(loc, SPEC_FILES.brief),
    readSpecFile(loc, SPEC_FILES.design),
    readSpecJson<SpecTicket[]>(loc, SPEC_FILES.tickets),
  ])
  if (!brief || !design || !tickets) throw new Error(`spec #${spec.number} is missing its brief, design or tickets`)
  const { base, head, diff, stat } = await changeDiff(storage, spec, loc)

  const reviewers = branchReviewers(run.config)
  const outcomes = await Promise.allSettled(
    reviewers.map(async (reviewer) => {
      const saved = await readSpecJson<BranchReviewResult>(loc, branchReviewFile(reviewer))
      if (saved) return { reviewer, result: saved }
      const result = await agents.json<BranchReviewResult>(
        {
          label: `review change · ${reviewer}`,
          phase: 'Review',
          seat: seatFor(run.config, reviewer),
          prompt: branchReviewPrompt({ brief, design, tickets, rulings: run.rulings, diff, stat, base, peerReviewer: reviewers.length > 1 }),
        },
        BRANCH_REVIEW_SCHEMA,
      )
      // Saved as each lands, so a failure elsewhere never costs a finished review.
      await writeSpecFiles(loc, { [branchReviewFile(reviewer)]: JSON.stringify(result, null, 2) }, `review by ${reviewer}`)
      return { reviewer, result }
    }),
  )
  const reviews = outcomes.flatMap((o) => (o.status === 'fulfilled' ? [o.value] : []))
  if (reviews.length === 0) {
    const first = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected')
    throw new Error(`every reviewer failed${first ? `: ${first.reason instanceof Error ? first.reason.message : String(first.reason)}` : ''}`)
  }

  const consolidated = await agents.json<SpecReview>(
    {
      label: `lead · ${run.config.lead.providerId}`,
      phase: 'Review',
      seat: run.config.lead,
      prompt: consolidateReviewPrompt({ design, tickets, reviews }),
    },
    SPEC_REVIEW_SCHEMA,
  )
  const stored: StoredReview = { ...consolidated, head, base, actOnBefore: consolidated.actOn.length }
  await writeSpecFiles(loc, { [SPEC_FILES.reviewJson]: JSON.stringify(stored, null, 2) }, 'review')

  // Real defects get one fix round before the user sees the change — one per
  // review: a review after the user's requested changes may have its own.
  const rounds = run.build.filter((b) => /^[RC]\d+$/.test(b.key))
  const fixedAlready = rounds.at(-1)?.key.startsWith('R') ?? false
  if (consolidated.actOn.length > 0 && !fixedAlready) {
    const key = `R${rounds.filter((b) => b.key.startsWith('R')).length + 1}`
    const fix = await addTicket(storage, spec, reviewFixesTicket(key, consolidated.actOn))
    storage.taskAppendActivity(spec.id, {
      kind: 'system',
      actorType: 'system',
      actorName: 'OperonSpec',
      body: `The review found ${consolidated.actOn.length} thing(s) to fix before sign-off — ticket #${fix.number} fixes them.`,
    })
    setStage(storage, spec.id, 'building')
    await advance(storage, spec.id)
    return null
  }
  return finalize(storage, spec, loc, stored)
}

async function recheck(
  storage: BuildStorage,
  agents: SpecAgents,
  spec: Task,
  loc: SpecLocation,
  stored: StoredReview,
): Promise<GateResult | null> {
  const run = storage.specRunGet(spec.id)
  if (!run) return null
  const { head, diff, stat } = await changeDiff(storage, spec, loc, stored.head)
  const rechecked = await agents.json<SpecReview>(
    {
      label: `recheck fixes · ${run.config.lead.providerId}`,
      phase: 'Review',
      seat: run.config.lead,
      prompt: recheckPrompt({ review: stored, diff, stat }),
    },
    SPEC_REVIEW_SCHEMA,
  )
  return finalize(storage, spec, loc, { ...rechecked, head, base: stored.base, actOnBefore: stored.actOnBefore })
}

async function finalize(storage: BuildStorage, spec: Task, loc: SpecLocation, review: StoredReview): Promise<GateResult> {
  const fixed = Math.max(0, review.actOnBefore - review.actOn.length)
  await writeSpecFiles(
    loc,
    {
      [SPEC_FILES.reviewJson]: JSON.stringify(review, null, 2),
      [SPEC_FILES.review]: renderReview(review, { fixed, base: review.base }),
    },
    'review ready for sign-off',
  )
  setStage(storage, spec.id, 'awaiting_signoff')
  // The change as a whole is what the user reviews now.
  if (spec.status !== 'in_review' && spec.status !== 'done') {
    storage.taskUpdate(spec.id, { status: 'in_review' }, { type: 'system', name: 'OperonSpec' })
    broadcastTask(storage, spec.id)
  }
  const failing = review.evidence.filter((e) => e.result === 'FAIL').length
  notifySpec(
    storage,
    spec,
    'spec_gate',
    review.actOn.length > 0 || failing > 0
      ? `#${spec.number} is ready for sign-off with open points — ${review.actOn.length} to act on, ${failing} criteria failing`
      : `#${spec.number} is built and reviewed — ready for your sign-off`,
  )
  return { operonSpec: { task: spec.number, stage: 'awaiting_signoff', next: signoffNext(spec.number, crossFamilyReviewed(storage.specRunGet(spec.id)?.build ?? [])) } }
}

/** The gate 2 header's numbers, from review.json. */
export async function reviewSummary(loc: SpecLocation): Promise<SpecReviewSummary | null> {
  const review = await readSpecJson<StoredReview>(loc, SPEC_FILES.reviewJson)
  if (!review) return null
  const count = (result: string) => review.evidence.filter((e) => e.result === result).length
  return {
    actOn: review.actOn.length,
    consider: review.consider.length,
    noted: review.noted.length,
    dismissed: review.dismissed.length,
    pass: count('PASS'),
    fail: count('FAIL'),
    notRun: count('NOT_RUN'),
    summary: review.summary,
  }
}

/**
 * Gate 2, "request changes": the user's comment becomes a ticket, built and
 * reviewed like the others; once it lands the whole change is reviewed again.
 */
export async function requestSignoffChanges(storage: BuildStorage, spec: Task, comment: string): Promise<Task> {
  const loc = locate(storage, spec)
  const run = storage.specRunGet(spec.id)
  const n = (run?.build.filter((b) => b.key.startsWith('C')).length ?? 0) + 1
  const ticket: SpecTicket = {
    key: `C${n}`,
    title: 'Changes requested',
    delivers: comment,
    acceptance: [`The change does what was asked: ${comment}`],
    blockedBy: [],
    interfaces: [],
  }
  // The next review is of the changed change, from scratch.
  const reviewers = run ? branchReviewers(run.config) : []
  await writeSpecFiles(
    loc,
    {
      [SPEC_FILES.reviewJson]: null,
      [SPEC_FILES.review]: null,
      ...Object.fromEntries(reviewers.map((r) => [branchReviewFile(r), null])),
    },
    'changes requested at sign-off',
  )
  const child = await addTicket(storage, spec, ticket)
  setStage(storage, spec.id, 'building')
  await advance(storage, spec.id)
  return child
}
