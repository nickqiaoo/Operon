/**
 * What a spec leaves behind: ADRs under `docs/adr/` and terms in `GLOSSARY.md`.
 *
 *   review ends   — the lead drafts them into `decisions.json` in the spec
 *                   directory, so the user sees them at gate 2 before signing
 *   gate 2 signed — they are written into the repository on the change branch
 *                   and merge into the default branch with the change
 *
 * ADRs are append-only: one file per decision, never edited; a changed decision
 * is a new ADR that names the one it supersedes. Two specs in flight therefore
 * never fight over a file. The only shared things are the ADR number and the
 * end of GLOSSARY.md, so before writing, the default branch is merged into the
 * change branch: numbers are counted on what the default branch already has,
 * and the glossary is appended to its latest text.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Task } from '../../types/task.js'
import type { SpecAdr, SpecDecisions, SpecGlossaryTerm } from '../../types/spec.js'
import { getCurrentBranch, getDefaultLocalBranch, mergeBranch } from '../git.js'
import type { SpecAgents } from './agents.js'
import { SPEC_FILES, readSpecFile, readSpecJson, writeSpecFiles, type SpecLocation } from './files.js'
import { DECISIONS_SCHEMA, decisionsPrompt, type DecisionsResult } from './prompts.js'
import type { BuildStorage } from './build-run.js'

export const ADR_DIR = path.posix.join('docs', 'adr')
export const GLOSSARY_FILE = 'GLOSSARY.md'

/** Cap on the glossary text handed to a prompt; the ADR index is short by nature. */
const MAX_GLOSSARY_CHARS = 12_000

interface RecordedAdr {
  number: number
  title: string
  file: string
}

/** ADRs in a checkout, by number. A file counts when its name starts with its number: `0007-some-slug.md`. */
async function listAdrs(root: string): Promise<RecordedAdr[]> {
  let names: string[]
  try {
    names = await fs.readdir(path.join(root, ADR_DIR))
  } catch {
    return []
  }
  const adrs: RecordedAdr[] = []
  for (const name of names) {
    const match = /^(\d+)-.*\.md$/.exec(name)
    if (!match) continue
    const text = await fs.readFile(path.join(root, ADR_DIR, name), 'utf8').catch(() => '')
    const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? name
    adrs.push({ number: Number(match[1]), title: heading.replace(/^\d+\.\s*/, ''), file: path.posix.join(ADR_DIR, name) })
  }
  return adrs.sort((a, b) => a.number - b.number)
}

/**
 * The decisions and terms a checkout already records, as markdown for a prompt:
 * the ADR index and the glossary. Empty when it has neither.
 */
export async function readRecorded(root: string): Promise<string> {
  const [adrs, glossary] = await Promise.all([
    listAdrs(root),
    fs.readFile(path.join(root, GLOSSARY_FILE), 'utf8').catch(() => null),
  ])
  const parts: string[] = []
  if (adrs.length > 0) {
    parts.push(`### ADRs (${ADR_DIR}/)\n${adrs.map((a) => `- ${pad(a.number)} ${a.title} — \`${a.file}\``).join('\n')}`)
  }
  if (glossary?.trim()) {
    const text = glossary.length > MAX_GLOSSARY_CHARS ? `${glossary.slice(0, MAX_GLOSSARY_CHARS)}\n…(truncated; read ${GLOSSARY_FILE})` : glossary
    parts.push(`### ${GLOSSARY_FILE}\n${text.trim()}`)
  }
  return parts.join('\n\n')
}

function pad(n: number): string {
  return String(n).padStart(4, '0')
}

function slugOf(raw: string, fallback: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || fallback
}

/**
 * Draft what the change should record, once per review: the lead reads the
 * brief, design and synthesis against what the repository already records.
 * Skipped when `decisions.json` exists. A failure is not the review's failure —
 * gate 2 simply has nothing to record — so it is reported, not thrown.
 */
export async function draftDecisions(
  storage: BuildStorage,
  agents: SpecAgents,
  spec: Task,
  loc: SpecLocation,
): Promise<void> {
  if (await readSpecJson<SpecDecisions>(loc, SPEC_FILES.decisions)) return
  const run = storage.specRunGet(spec.id)
  if (!run) return
  const [brief, answers, design, synthesis, recorded] = await Promise.all([
    readSpecFile(loc, SPEC_FILES.brief),
    readSpecFile(loc, SPEC_FILES.answers),
    readSpecFile(loc, SPEC_FILES.design),
    readSpecFile(loc, SPEC_FILES.synthesis),
    readRecorded(loc.worktreePath),
  ])
  if (!brief || !design) return
  try {
    const result = await agents.json<DecisionsResult>(
      {
        label: `decisions · ${run.config.lead.providerId}`,
        phase: 'Review',
        seat: run.config.lead,
        prompt: decisionsPrompt({
          brief,
          answers,
          design,
          synthesis,
          rulings: run.rulings.map((r) => `${r.ticketKey}: ${r.ruling}`),
          recorded,
        }),
      },
      DECISIONS_SCHEMA,
    )
    const decisions: SpecDecisions = {
      adrs: result.adrs.slice(0, 3).map((a, i) => ({ ...a, slug: slugOf(a.slug || a.title, `decision-${i + 1}`), number: null })),
      glossary: result.glossary.filter((g) => g.term.trim() && g.definition.trim()),
      recorded: null,
    }
    await writeSpecFiles(loc, { [SPEC_FILES.decisions]: JSON.stringify(decisions, null, 2) }, 'decisions to record')
  } catch (err) {
    storage.taskAppendActivity(spec.id, {
      kind: 'system',
      actorType: 'system',
      actorName: 'OperonSpec',
      body: `Could not draft the ADRs and glossary terms for this change: ${err instanceof Error ? err.message : String(err)}. Signing off will record none.`,
    })
  }
}

/** One ADR file. Status and the spec it came from go on top; the three sections follow. */
export function renderAdr(adr: SpecAdr, number: number, specNumber: number): string {
  const status = `Status: accepted · Spec: task-${specNumber}${adr.supersedes != null ? ` · Supersedes: ${pad(adr.supersedes)}` : ''}`
  return [
    `# ${pad(number)}. ${adr.title}`,
    status,
    `## Context\n${adr.context.trim()}`,
    `## Decision\n${adr.decision.trim()}`,
    `## Consequences\n${adr.consequences.trim()}`,
  ].join('\n\n') + '\n'
}

/**
 * GLOSSARY.md with the new terms added: a term the file already names (as a
 * heading or a bold entry) is left alone — the glossary is the user's, and a
 * changed definition is for a person to make.
 */
export function appendGlossary(current: string | null, terms: readonly SpecGlossaryTerm[]): { text: string; added: number } {
  const known = (current ?? '').toLowerCase()
  const fresh = terms.filter((t) => {
    const term = t.term.trim().toLowerCase()
    return !known.includes(`**${term}**`) && !new RegExp(`^#+\\s+${escapeRegExp(term)}\\s*$`, 'm').test(known)
  })
  if (fresh.length === 0) return { text: current ?? '', added: 0 }
  const lines = fresh.map((t) => `- **${t.term.trim()}**: ${t.definition.trim().replace(/\s*\n\s*/g, ' ')}`)
  const base = current?.trim() ? current.trimEnd() : '# Glossary\n\nDomain terms used in this project.'
  return { text: `${base}\n\n${lines.join('\n')}\n`, added: fresh.length }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Gate 2: write the drafted ADRs and terms into the repository on the change
 * branch, so the merge into the default branch carries them. Idempotent: once
 * written (`recorded` set) a second sign-off attempt — say after the default
 * checkout was dirty — writes nothing again.
 */
export async function recordDecisions(storage: BuildStorage, spec: Task, loc: SpecLocation): Promise<string[]> {
  const decisions = await readSpecJson<SpecDecisions>(loc, SPEC_FILES.decisions)
  if (!decisions || decisions.recorded) return decisions?.recorded?.files ?? []
  if (decisions.adrs.length === 0 && decisions.glossary.length === 0) return []

  // Count and append on top of the default branch as it is now — another spec
  // may have recorded its own since this change branched off.
  const project = storage.getProject(spec.projectId)
  if (project) {
    const target = (await getDefaultLocalBranch(project.rootPath)) ?? (await getCurrentBranch(project.rootPath))
    if (target) await mergeBranch(loc.worktreePath, target, `Merge ${target} into ${spec.branchName} before recording decisions`)
  }

  const files: string[] = []
  let next = ((await listAdrs(loc.worktreePath)).at(-1)?.number ?? 0) + 1
  const adrs: SpecAdr[] = []
  for (const adr of decisions.adrs) {
    const number = next++
    const rel = path.posix.join(ADR_DIR, `${pad(number)}-${adr.slug}.md`)
    await fs.mkdir(path.join(loc.worktreePath, ADR_DIR), { recursive: true })
    await fs.writeFile(path.join(loc.worktreePath, rel), renderAdr(adr, number, spec.number), 'utf8')
    files.push(rel)
    adrs.push({ ...adr, number })
  }
  if (decisions.glossary.length > 0) {
    const abs = path.join(loc.worktreePath, GLOSSARY_FILE)
    const current = await fs.readFile(abs, 'utf8').catch(() => null)
    const { text, added } = appendGlossary(current, decisions.glossary)
    if (added > 0) {
      await fs.writeFile(abs, text, 'utf8')
      files.push(GLOSSARY_FILE)
    }
  }

  const done: SpecDecisions = { ...decisions, adrs, recorded: { at: Date.now(), files } }
  await writeSpecFiles(loc, { [SPEC_FILES.decisions]: JSON.stringify(done, null, 2) }, 'record decisions', { alsoCommit: files })
  if (files.length > 0) {
    storage.taskAppendActivity(spec.id, {
      kind: 'system',
      actorType: 'system',
      actorName: 'OperonSpec',
      body: `Recorded ${files.map((f) => `\`${f}\``).join(', ')}`,
      meta: { event: 'spec.decisions', files },
    })
  }
  return files
}
