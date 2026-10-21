import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpecDecisions } from '../../types/spec.js'
import type { Task } from '../../types/task.js'
import { appendGlossary, readRecorded, recordDecisions, renderAdr } from './decisions.js'
import { unreviewedFiles } from './review-run.js'

let root: string
let repo: string
let worktree: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function write(dir: string, rel: string, content: string) {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
  await fs.writeFile(path.join(dir, rel), content)
}

const spec = { id: 1, number: 7, projectId: 1, branchName: 'operon/task-7', workspaceId: 1 } as Task
const loc = () => ({ taskId: 1, taskNumber: 7, worktreePath: worktree })
const storage = () =>
  ({
    getProject: () => ({ id: 1, rootPath: repo }),
    getWorkspace: () => ({ id: 1, worktreePath: worktree }),
    taskAppendActivity: vi.fn(),
  }) as never

const drafted: SpecDecisions = {
  adrs: [
    {
      slug: 'reminders-own-table',
      title: 'Reminders get their own table',
      context: 'Notifications are merged by source key.',
      decision: 'A reminders table, read by the scheduler.',
      consequences: 'A status column on notifications was turned down: merging would wipe it.',
      supersedes: 1,
      number: null,
    },
  ],
  glossary: [
    { term: 'Snooze', definition: 'Hide a notification\nuntil a set time.' },
    { term: 'Inbox', definition: 'Already defined, so left alone.' },
  ],
  recorded: null,
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-decisions-'))
  repo = path.join(root, 'repo')
  worktree = path.join(root, 'wt')
  await fs.mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  await write(repo, 'docs/adr/0001-first.md', '# 0001. Notifications merge by source key\n')
  await write(repo, 'GLOSSARY.md', '# Glossary\n\n- **Inbox**: where notifications land.\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  git(repo, 'worktree', 'add', '-q', '-b', 'operon/task-7', worktree)
  // Another spec landed its own ADR on main after this change branched.
  await write(repo, 'docs/adr/0002-other.md', '# 0002. Something else\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'other spec')
  await write(worktree, '.operon/changes/task-7/decisions.json', JSON.stringify(drafted))
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-q', '-m', 'drafted')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('recordDecisions', () => {
  it('numbers after what the default branch has, appends new terms only, and commits', async () => {
    const files = await recordDecisions(storage(), spec, loc())

    expect(files).toEqual(['docs/adr/0003-reminders-own-table.md', 'GLOSSARY.md'])
    const adr = await fs.readFile(path.join(worktree, files[0]), 'utf8')
    expect(adr).toMatch(/^# 0003\. Reminders get their own table\n/)
    expect(adr).toContain('Status: accepted · Spec: task-7 · Supersedes: 0001')
    expect(adr).toContain('## Consequences\nA status column')
    const glossary = await fs.readFile(path.join(worktree, 'GLOSSARY.md'), 'utf8')
    expect(glossary).toContain('- **Snooze**: Hide a notification until a set time.')
    expect(glossary.match(/\*\*Inbox\*\*/g)).toHaveLength(1)
    // The earlier ADR is untouched, and main's newer one came in with the merge.
    expect(await fs.readFile(path.join(worktree, 'docs/adr/0002-other.md'), 'utf8')).toContain('Something else')

    const stored = JSON.parse(await fs.readFile(path.join(worktree, '.operon/changes/task-7/decisions.json'), 'utf8')) as SpecDecisions
    expect(stored.recorded?.files).toEqual(files)
    expect(stored.adrs[0].number).toBe(3)
    expect(git(worktree, 'status', '--porcelain')).toBe('')
  })

  it('writes nothing the second time', async () => {
    const first = await recordDecisions(storage(), spec, loc())
    const head = git(worktree, 'rev-parse', 'HEAD')
    expect(await recordDecisions(storage(), spec, loc())).toEqual(first)
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('merges a default branch whose name has a slash in it', async () => {
    git(repo, 'branch', '-m', 'main', 'release/2.x')
    git(repo, 'remote', 'add', 'origin', 'https://example.com/repo.git')
    git(repo, 'update-ref', 'refs/remotes/origin/release/2.x', 'release/2.x')
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release/2.x')

    expect(await recordDecisions(storage(), spec, loc())).toEqual(['docs/adr/0003-reminders-own-table.md', 'GLOSSARY.md'])
    expect(git(worktree, 'log', '--format=%s', '-2')).toContain('Merge release/2.x into operon/task-7')
  })

  it('does nothing when there is nothing to record', async () => {
    await write(worktree, '.operon/changes/task-7/decisions.json', JSON.stringify({ adrs: [], glossary: [], recorded: null }))
    git(worktree, 'commit', '-qam', 'empty')
    const head = git(worktree, 'rev-parse', 'HEAD')
    expect(await recordDecisions(storage(), spec, loc())).toEqual([])
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head)
  })
})

describe('unreviewedFiles', () => {
  /** The change as gate 2 shows it: reviewed at its current head. */
  async function reviewedNow() {
    const head = git(worktree, 'rev-parse', 'HEAD').trim()
    await write(worktree, '.operon/changes/task-7/review.json', JSON.stringify({ head, base: 'main' }))
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-q', '-m', 'review')
  }

  it('lets through what sign-off itself merged and wrote', async () => {
    await write(worktree, 'feature.ts', 'export const x = 1\n')
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-q', '-m', 'ticket work')
    await reviewedNow()
    // A sign-off that recorded the decisions, then could not merge into main.
    await recordDecisions(storage(), spec, loc())
    expect(await unreviewedFiles(storage(), spec)).toEqual([])
  })

  it('names work committed after the review', async () => {
    await reviewedNow()
    await write(worktree, 'feature.ts', 'export const x = 2\n')
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-q', '-m', 'unreviewed')
    expect(await unreviewedFiles(storage(), spec)).toEqual(['feature.ts'])
  })

  it('has nothing to say without a review', async () => {
    await write(worktree, 'feature.ts', 'export const x = 2\n')
    git(worktree, 'add', '-A')
    git(worktree, 'commit', '-q', '-m', 'unreviewed')
    expect(await unreviewedFiles(storage(), spec)).toEqual([])
  })
})

describe('readRecorded', () => {
  it('lists ADR titles and the glossary', async () => {
    const text = await readRecorded(repo)
    expect(text).toContain('- 0001 Notifications merge by source key — `docs/adr/0001-first.md`')
    expect(text).toContain('- 0002 Something else')
    expect(text).toContain('**Inbox**')
  })
  it('is empty for a repository with neither', async () => {
    expect(await readRecorded(path.join(root, 'nowhere'))).toBe('')
  })
})

describe('appendGlossary', () => {
  it('starts a glossary when there is none', () => {
    const { text, added } = appendGlossary(null, [{ term: 'Snooze', definition: 'Later.' }])
    expect(added).toBe(1)
    expect(text).toBe('# Glossary\n\nDomain terms used in this project.\n\n- **Snooze**: Later.\n')
  })
  it('leaves a term the file names as a heading', () => {
    expect(appendGlossary('# Glossary\n\n## Snooze\nLater.\n', [{ term: 'snooze', definition: 'x' }]).added).toBe(0)
  })
})

describe('renderAdr', () => {
  it('has no supersedes line when it replaces nothing', () => {
    expect(renderAdr({ ...drafted.adrs[0], supersedes: null }, 12, 7)).toContain('Status: accepted · Spec: task-7\n')
  })
})
