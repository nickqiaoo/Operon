/**
 * The review stage of a spec: ⑥ Review, once every ticket is merged.
 *
 *   reviewing        — two reviewers from different families review the whole
 *                      change against its base, checking every acceptance
 *                      criterion with evidence → the lead merges them into one
 *                      verdict in four piles (act on / consider / noted / dismissed)
 *   (act on?)        — one "Review fixes" ticket, built and reviewed like any
 *                      other; once it lands the lead re-checks only the fix
 *   awaiting_signoff — the lead drafts the ADRs and glossary terms the change
 *                      will record (decisions.ts), review.md is written, and
 *                      gate 2 waits for the user
 *
 * Like the design stage, each step is idempotent on the change branch: a
 * reviewer whose `reviews/<provider>.json` exists is not run again, and
 * `review.json` without `review.md` means a fix round is out. The agents are
 * recorded in the spec's workflow run through the build stage's session, and
 * gate 2 is reported back to the chat that started the spec.
 */

import type { Task } from '../../types/task.js'
import type {
  SpecDecisions,
  SpecIntegration,
  SpecReviewSummary,
  SpecRunConfig,
  SpecSeat,
  SpecStage,
  SpecTicket,
  SpecTicketBuild,
} from '../../types/spec.js'
import {
  diffBeyondMerge,
  filesChangedBeyondMerge,
  getCurrentBranch,
  getDefaultLocalBranch,
  getDiffStatText,
  getFileDiffRange,
  getHeadSha,
  getMergeBase,
} from '../git.js'
import { broadcastTask } from '../task-events.js'
import type { SpecAgents } from './agents.js'
import { addTicket, advance, notifySpec, sessionFor, type BuildStorage } from './build-run.js'
import { familyOf, seatFor } from './config.js'
import { draftDecisions } from './decisions.js'
import { onStepFailed, wakeCoordinator } from './coordinator.js'
import { SPEC_FILES, branchReviewFile, readSpecFile, readSpecJson, specDir, writeSpecFiles, type SpecLocation } from './files.js'
import {
  BRANCH_REVIEW_SCHEMA,
  SPEC_REVIEW_SCHEMA,
  branchReviewPrompt,
  consolidateReviewPrompt,
  integrationMessage,
  integrationReviewPrompt,
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
  // A reviewer the user set is always one of them.
  const order = [...(config.reviewer ? [config.reviewer] : []), config.judge, config.builder, ...config.candidates, config.lead, config.explorer].map(
    (s) => s.providerId,
  )
  const picked: string[] = []
  for (const id of order) {
    if (picked.length === 2) break
    if (!picked.includes(id) && !picked.some((p) => familyOf(p) === familyOf(id))) picked.push(id)
  }
  return picked
}

/**
 * Who checks a sign-off conflict the coordinator resolved: a whole-change
 * reviewer from a family other than the coordinator's (the lead's) — or, in a
 * spec with one family, the first reviewer.
 */
export function integrationReviewer(config: SpecRunConfig): SpecSeat {
  const reviewers = branchReviewers(config)
  const lead = familyOf(config.lead.providerId)
  const id = reviewers.find((p) => familyOf(p) !== lead) ?? reviewers[0] ?? config.lead.providerId
  return seatFor(config, id)
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
      const integration = await readSpecJson<SpecIntegration>(loc, SPEC_FILES.integration)
      // A sign-off conflict not handed in yet is still the coordinator's.
      if (integration && !integration.summary) {
        setStage(storage, specId, 'integrating')
        return
      }
      const gate =
        integration && stored
          ? await integrationReview(storage, agents, spec, loc, stored, integration)
          : stored && !final
            ? await recheck(storage, agents, spec, loc, stored)
            : await review(storage, agents, spec, loc)
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
      void onStepFailed(storage, spec, 'the whole-change review', reason, { role: 'reviewer' })
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
  return finalize(storage, agents, spec, loc, stored)
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
  return finalize(storage, agents, spec, loc, { ...rechecked, head, base: stored.base, actOnBefore: stored.actOnBefore })
}

/** The coordinator resolved a sign-off conflict: another family checks the resolution, then gate 2 again. */
async function integrationReview(
  storage: BuildStorage,
  agents: SpecAgents,
  spec: Task,
  loc: SpecLocation,
  stored: StoredReview,
  integration: SpecIntegration,
): Promise<GateResult | null> {
  const run = storage.specRunGet(spec.id)
  if (!run) return null
  const head = await getHeadSha(loc.worktreePath)
  if (!head) throw new Error(`spec #${spec.number}'s change branch has no commits`)
  const own = specDir(spec.number)
  const [diff, files] = await Promise.all([
    diffBeyondMerge(loc.worktreePath, stored.head, integration.target, [own]),
    filesChangedBeyondMerge(loc.worktreePath, stored.head, integration.target),
  ])
  const seat = integrationReviewer(run.config)
  const checked = await agents.json<SpecReview>(
    {
      label: `review merge · ${seat.providerId}`,
      phase: 'Review',
      seat,
      prompt: integrationReviewPrompt({
        review: stored,
        target: integration.target,
        files: integration.files,
        summary: integration.summary ?? '',
        diff,
        stat: (files ?? []).filter((f) => !f.startsWith(`${own}/`)).join('\n'),
      }),
    },
    SPEC_REVIEW_SCHEMA,
  )
  const gate = await finalize(storage, agents, spec, loc, { ...checked, head, base: stored.base, actOnBefore: stored.actOnBefore })
  await writeSpecFiles(loc, { [SPEC_FILES.integration]: null }, 'sign-off conflict reviewed')
  return gate
}

/**
 * Signing gate 2 hit a conflict merging the default branch in. The coordinator
 * resolves it on the change branch (stage integrating) and hands it in through
 * spec_integration_done, which sends the result to integrationReview. False when
 * there is no coordinator to wake — the spec stays at gate 2.
 */
export async function startIntegration(storage: BuildStorage, spec: Task, target: string, files: string[]): Promise<boolean> {
  const loc = locate(storage, spec)
  const integration: SpecIntegration = { target, files, startedAt: Date.now() }
  await writeSpecFiles(loc, { [SPEC_FILES.integration]: JSON.stringify(integration, null, 2) }, 'sign-off conflict')
  setStage(storage, spec.id, 'integrating')
  const woke = await wakeCoordinator(
    storage,
    spec,
    integrationMessage({ specNumber: spec.number, branch: spec.branchName ?? `operon/task-${spec.number}`, target, files }),
  )
  if (!woke) {
    await writeSpecFiles(loc, { [SPEC_FILES.integration]: null }, 'no coordinator for the sign-off conflict')
    setStage(storage, spec.id, 'awaiting_signoff')
    return false
  }
  storage.taskAppendActivity(spec.id, {
    kind: 'system',
    actorType: 'system',
    actorName: 'OperonSpec',
    body:
      `Merging \`${target}\` in conflicted in ${files.map((f) => `\`${f}\``).join(', ') || 'some files'}. ` +
      'The coordinator is resolving it; the result is reviewed before you sign off again.',
    meta: { event: 'spec.integrating', target, files },
  })
  return true
}

async function finalize(
  storage: BuildStorage,
  agents: SpecAgents,
  spec: Task,
  loc: SpecLocation,
  review: StoredReview,
): Promise<GateResult> {
  // What the change will record goes in front of the user with the review, before review.md marks the gate.
  await draftDecisions(storage, agents, spec, loc)
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
 * What the change branch gained since the review gate 2 shows, beyond the
 * default branch merged in, the spec's own files and the decisions it recorded:
 * work nobody reviewed, such as a merge conflict settled by hand. Empty when the
 * branch is as reviewed, or there is no review to compare with.
 */
export async function unreviewedFiles(storage: BuildStorage, spec: Task): Promise<string[]> {
  const loc = locate(storage, spec)
  const stored = await readSpecJson<StoredReview>(loc, SPEC_FILES.reviewJson)
  if (!stored?.head) return []
  const project = storage.getProject(spec.projectId)
  const ref = (project ? await getDefaultLocalBranch(project.rootPath) : null) ?? stored.base
  const changed = await filesChangedBeyondMerge(loc.worktreePath, stored.head, ref)
  if (!changed) return []
  const decisions = await readSpecJson<SpecDecisions>(loc, SPEC_FILES.decisions)
  const recorded = new Set(decisions?.recorded?.files ?? [])
  const own = `${specDir(spec.number)}/`
  return changed.filter((file) => !file.startsWith(own) && !recorded.has(file))
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
  // The next review is of the changed change, from scratch — and so is what it
  // records, unless an earlier sign-off attempt already wrote that into the repository.
  const reviewers = run ? branchReviewers(run.config) : []
  const decisions = await readSpecJson<SpecDecisions>(loc, SPEC_FILES.decisions)
  await writeSpecFiles(
    loc,
    {
      [SPEC_FILES.reviewJson]: null,
      [SPEC_FILES.review]: null,
      ...Object.fromEntries(reviewers.map((r) => [branchReviewFile(r), null])),
      ...(decisions && !decisions.recorded ? { [SPEC_FILES.decisions]: null } : {}),
      [SPEC_FILES.integration]: null,
    },
    'changes requested at sign-off',
  )
  const child = await addTicket(storage, spec, ticket)
  setStage(storage, spec.id, 'building')
  await advance(storage, spec.id)
  return child
}
