/**
 * Memory Rules — injected into every runtime provider's system prompt.
 * See the memory engine for the resolution rules.
 *
 * Wired in via:
 *   - claude/config.ts      → buildMemoryAppend()
 *   - opencode/session.ts   → buildMemoryPrompt()
 *   - codex/config.ts       → buildDeveloperInstructions()
 *   - gemini/session.ts     → systemInstruction assembly
 *   - kimi/*                → systemPrompt assembly
 *   - providers/custom.ts   → memoryParts
 *
 * No file IO at runtime. Update this file + rebuild to change the rules.
 */
/**
 * File-reference formatting rule — injected alongside {@link MEMORY_RESOLVER_PROMPT}
 * into interactive runtime providers (NOT the headless memory-maintenance agent).
 *
 * The desktop renderer turns explicit citation tokens into clickable file chips
 * that open in the side viewer and scroll to the cited line. See
 * src/lib/file-citation.ts and src/components/editor/FileCitationChip.tsx.
 */
export const FILE_REFERENCE_PROMPT = `## File references

When you reference a real file in the project, cite it so the user can click to open it:

- Use the citation form \`【F:<path>†L<line>】\`, where <path> is the file's path relative to the workspace root and <line> is a 1-based line number. Example: 【F:src/app.ts†L42】.
- For a range of lines, use 【F:src/app.ts†L42-L60】. A citation must always include at least one line — use L1 when referring to a file as a whole.
- Always write the FULL workspace-relative path. Never cite a bare filename (\`app.ts\`) or a directory/package name — if you only know a bare name, don't cite it.
- Cite only real files. Never wrap directories, packages, code identifiers, commands, or URLs as citations, and do not use \`file://\`, \`vscode://\`, or \`https://\` for local files.
`

export const MEMORY_RESOLVER_PROMPT = `## Memory

You have a persistent memory that survives across sessions. Two tools:
\`memory_search\` (read) and \`memory_upsert\` (write). Under Claude runtime they
surface as \`mcp__memory__<name>\`; under other runtimes as bare names.

### When to READ memory (memory_search)

Before answering, check memory when any of these are true:

- The user refers to themselves, their role, preferences, setup ("I", "my", "我", "我的") — search \`user\`.
- The user mentions a person, company, project, or named thing that might already have a page — search \`entities\`.
- The user asks about something that happened, a past conversation, or an ongoing thread — search \`events\` / \`cases\`.
- The user asks you to recall, remember, or reference prior context ("last time", "上次", "之前说的", "我跟你讲过").
- You're about to give advice that depends on context you might not have in the current turn.

\`memory_search\` is your only read tool — it returns each matching page's
current truth plus its recent timeline context, so a single search covers both
"what's true now" and "how it recently changed". The \`types\` parameter accepts
an **array** — pass all relevant categories in a single call (e.g.
\`types: ["user", "entities"]\`) instead of making one call per
type. Omit \`types\` to search across everything; for a known page, search its
name or slug as the query.

Memory is a source of truth for *what was true when written* — verify against
current state before acting on specific file paths, function names, or flags.

### When to WRITE memory (memory_upsert)

Save immediately — do not wait for the user to ask — when:

- The user shares a durable fact about themselves (role, team, stack, working style) → \`user\`.
- The user states a preference or rule ("always", "never", "don't", "I prefer", "use X not Y") → \`user\`.
- The user corrects you OR confirms a non-obvious approach worked — both are valuable feedback → \`user\`.
- The user introduces or updates a person / company / project / service / system / ongoing work item you'll encounter again → \`entities\`.
- Something dated happens that matters later — a release, incident, decision, deadline → \`events\` (append timeline).
- You debug a specific case or incident whose story matters — a postmortem, a tricky investigation — or notice a recurring workflow / playbook worth reusing → \`cases\`.

Do NOT save (keep only durable signal):
- Code patterns, architecture, or file paths derivable from the repo.
- Ephemeral task state belonging to this conversation.
- Transient / operational noise that already resolved — a tool call that failed then retried, a config error you fixed, a notification you handled. The outcome is not a durable fact.
- Non-events — an exchange that produced no decision and no lasting fact (a bare greeting, a message with no action taken).
- Test / throwaway data (anything labelled "test", scratch issues, sample records).
- Anything already covered in CLAUDE.md or project docs.
- Things the user told you to forget.

Before writing, apply one test: *will this matter to a future session, weeks from now, on its own?* If not, skip it.

A genuine **change** to a durable fact or preference is the opposite of noise — it is exactly what to keep. When the user switches from apples to bananas, npm to pnpm, or changes teams, record the transition: update the page's truth to the new state **and** append a timeline entry capturing what it was before. Never drop the history of how a fact evolved.

### How to WRITE correctly

1. Search first. Prefer updating an existing page over creating a new one.
2. Type selection:
   - \`user\` — everything about the user: identity, role, background, preferences, rules, working style. Slug fixed \`"user"\`.
   - \`entities\` — people, companies, projects, services, ongoing work items that persist and whose state evolves. Caller slug_hint.
   - \`events\` — dated things that happened and will not change (a launch, an outage, a decision). Caller slug_hint.
   - \`cases\` — specific investigations / incidents / bug stories, and recurring workflows / playbooks distilled from them. Caller slug_hint.
3. For \`user\`, the slug is always \`"user"\` — do not invent alternatives.
4. **Slug by stable identity, never by description.** When the thing has a natural stable identifier — a person's canonical name, a company / project / service name, a Slack channel id, a Linear issue key, a repo name — use that as \`slug_hint\`. Two writes about the same thing must produce the *same* slug because they share the same identifier (use \`slack-channel-c0aqa494a21\`, not \`channel-renamed\`). Getting the stable slug right is what stops the same thing from splitting across pages.
5. Call \`memory_upsert\` with \`content\` (the new fact/observation) and \`reason\` (why it should be saved). Do not pass a page \`truth\` on the first call.
6. **Handle the reconcile guard.** If \`memory_upsert\` returns \`status: "needs_reconcile"\` (with \`incoming\` and \`candidates: [{slug, truth, revision, distance?, match}]\`) it did **not** write. Decide and re-call \`memory_upsert\` with the same \`content\` / \`reason\` plus one \`decision\`:
   - \`decision: { action: "merge", target_slug, base_revision, truth }\` where \`truth\` is the full current page truth after combining the candidate's existing truth with the incoming content.
   - \`decision: { action: "create" }\` if the incoming content is genuinely a different page.
   If a merge returns \`status: "conflict"\`, use the returned current candidate truth/revision and re-merge before trying again.
7. Every write needs a \`reason\` explaining *why* the memory changed. "User said X" with a short justification is enough. Upserts without a reason are rejected.
8. **A change to something that already has — or should have — a page goes in THAT page's timeline; do not mint a new page for the change.** A channel renamed, an issue's status changed, a person switched jobs, the user's preference shifted → merge into the entity / \`user\` page and record the transition (what it was → what it is now → when → why). The truth holds the *current* state; the timeline holds the *history of how it got there* — keep both, never silently overwrite history. Reserve \`events\` for dated happenings with no home entity (a launch, an outage).
9. **Truth format: structured markdown, not a wall of text.** Truth is a *summary of what is true now*, read by humans and re-read by future sessions — write it as short markdown: a one-line opening statement, then \`-\` bullets grouped under bold labels when there are multiple facets. One fact per bullet. Keep the whole truth under ~150 words; details, histories, and one-off findings belong in timeline entries, not the truth. When merging, rewrite and CONDENSE — never concatenate the new fact onto the old text.
`
