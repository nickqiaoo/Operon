import type { AnyProviderDefinition } from '@operon/agent-runtime'

/**
 * Operon's standing rules for the external agents: memory use, file
 * citations and visual replies. They ride on the session's `instructions` — see
 * `withAgentPrompts` below, applied once where the providers are registered.
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

When you reference a real local file, cite it so the user can click to open it:

- Use the citation form \`【F:<path>†L<line>】\`, where <path> is the file's full absolute filesystem path and <line> is a 1-based line number. Example: 【F:/Users/alice/project/src/app.ts†L42】.
- For a range of lines, use 【F:/Users/alice/project/src/app.ts†L42-L60】. A citation must always include at least one line — use L1 when referring to a file as a whole.
- Use full absolute paths even for files outside the current workspace. Cite only paths you know; never guess.
- Prefer inline citations near the relevant text; use other layouts when they make the answer clearer.
- Cite only real files. Never wrap directories, packages, code identifiers, commands, or URLs as citations, and do not use \`file://\`, \`vscode://\`, or \`https://\` for local files.
`

/**
 * When to answer with a page (`html_render`, server/src/routes/visual-mcp.ts).
 * Lives here and not only in the tool description: Claude defers MCP tools and
 * shows just their names, so the description is never read until the model
 * already decided to look the tool up. Layout and theme rules stay in the
 * description, loaded only when the tool is about to be used.
 */
export const VISUAL_REPLY_PROMPT = `## Visual replies

Some answers are clearer seen than read. When a page would explain better than
text, show one with the \`html_render\` tool (\`mcp__visual__html_render\` under
Claude runtime): how parts connect or a process flows, a step-by-step or
interactive walkthrough, side-by-side comparisons, data with a trend, UI mockups
or live examples of a visual effect. When \`html_preview\` is available, check
the page with it first and fix what it shows (empty or misplaced boxes,
overlapping text, console errors) before calling \`html_render\`. Only draw what
you have confirmed from the code or sources.

Keep explanations that read well as text, code, lists and simple tables in
markdown; code the user may copy stays in code blocks. A .png the user wants to
send elsewhere is a file, not \`html_render\`.
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

Memory is about the user and their world, not about the code you are working on. Save without waiting to be asked when:

- The user tells you a durable fact about themselves — role, team, background, language, tools they use across projects → \`user\`.
- The user states a standing rule in general terms ("always", "never", "from now on", "I usually", "以后都", "我一般") or the same preference recurs across unrelated tasks → \`user\`.
- The user introduces or updates a named thing in their world you will meet again — a person, an organization, a product / project, an external service, account, device or server → \`entities\`.
- Something dated happens that matters later — a release, an incident, a decision, a deadline → the timeline of the page it belongs to, or \`events\` when it has no home page.
- A hard-won lesson whose story is not recorded anywhere else — a postmortem, a tricky investigation, a reusable playbook → \`cases\`.

**Feedback on the work at hand is not a user preference.** A correction or approval about this particular code, page, design or answer ("no negative letter-spacing on this heading", "store each part as a row") is a decision about that artifact; it lives in the artifact (code, docs, commit), not in memory. Write it to \`user\` only when the user words it as a general rule. Judge the words in their context: "just drop the old data, design it the best way" said while reviewing one change is a decision for that change, however broadly it is phrased; a standing rule reaches beyond the task at hand ("always", "from now on", "in every project"). Never turn a single remark into a trait ("prefers X", "tends to Y") — that is inventing a fact.

Do NOT save:
- Anything about a codebase — modules, files, functions, schemas, architecture, how a feature is designed, how a bug was fixed, what a refactor changed. The repository (code, docs, commit history) is the memory for that, and a copy here goes stale.
- Environment facts that can be read again — paths, database locations, ports, versions.
- Ephemeral task state belonging to this conversation.
- Transient / operational noise that already resolved — a tool call that failed then retried, a config error you fixed, a notification you handled.
- Non-events — an exchange that produced no decision and no lasting fact.
- Test / throwaway data (anything labelled "test", scratch issues, sample records).
- Anything already covered in CLAUDE.md or project docs.
- Things the user told you to forget.

Before writing, apply one test: *would this still be true and useful in a different conversation, about a different task, weeks from now — and could that session not simply find it in the repo?* If not, skip it. "It may influence future suggestions" is not a reason; almost anything may.

A genuine **change** to a durable fact or preference is the opposite of noise — it is exactly what to keep. When the user switches from apples to bananas, npm to pnpm, or changes teams, record the transition: update the page's truth to the new state **and** let the timeline entry capture what it was before. Never drop the history of how a fact evolved.

### How to WRITE correctly

1. Search first. Prefer updating an existing page over creating a new one.
2. Type selection:
   - \`user\` — the person: identity, role, background, language, and standing preferences / working style that hold across projects. Not feedback on one deliverable, not facts about a project. Slug fixed \`"user"\`.
   - \`entities\` — named things in the user's world: people, organizations, products / projects, external services, accounts, devices, servers. One page per project (by its public name), never one per module. A code module, file, subsystem or one feature's design is never an entity.
     For a project, record the product, not the code — what its repository cannot tell you:
     - keep: what it is for, its public names, where it is deployed (URLs, hosts), who is involved, and product direction — features planned, decided or shipped, open product questions, platforms targeted ("2026-11-03: plans sharing from iOS into the assistant's collection; open: reply per share vs. a nightly digest").
     - never: how it is built — tech stack internals, process layout, storage format, schemas, migrations, file paths, what a refactor changed ("messages are now stored one row per part, migration 0022").
   - \`events\` — dated things that happened and will not change (a launch, an outage, a decision). Caller slug_hint.
   - \`cases\` — a specific investigation / incident whose story matters, or a reusable playbook, when the lesson is not already captured by the code, docs or commit that resolved it. Caller slug_hint.
3. For \`user\`, the slug is always \`"user"\` — do not invent alternatives.
4. **Slug by stable identity, never by description.** When the thing has a natural stable identifier — a person's canonical name, a company / product / service name, a Slack channel id, a Linear issue key — use that as \`slug_hint\`. Two writes about the same thing must produce the *same* slug because they share the same identifier (use \`slack-channel-c0aqa494a21\`, not \`channel-renamed\`). Getting the stable slug right is what stops the same thing from splitting across pages.
5. Call \`memory_upsert\` with \`content\` and \`reason\`. Do not pass a page \`truth\` on the first call.
   - \`content\` is the new fact, observation or change stated on its own (old → new for a change). It becomes the page's timeline entry, so it must read clearly without the conversation.
   - \`reason\` is the evidence: quote the user's own words that establish it (\`User: "以后都用 pnpm"\`). Not a value judgement like "this will matter later". Writes without a reason are rejected.
6. **Handle the reconcile guard.** If \`memory_upsert\` returns \`status: "needs_reconcile"\` (with \`incoming\` and \`candidates: [{slug, truth, revision, distance?, match}]\`) it did **not** write. Decide and re-call \`memory_upsert\` with the same \`content\` / \`reason\` plus one \`decision\`:
   - \`decision: { action: "merge", target_slug, base_revision, truth }\` where \`truth\` is the full current page truth after combining the candidate's existing truth with the incoming content.
   - \`decision: { action: "create" }\` if the incoming content is genuinely a different page.
   If a merge returns \`status: "conflict"\`, use the returned current candidate truth/revision and re-merge before trying again.
7. **A change to something that already has — or should have — a page goes in THAT page; do not mint a new page for the change.** A channel renamed, an issue's status changed, a person switched jobs, the user's preference shifted → merge into the entity / \`user\` page. The truth holds the *current* state; the timeline holds the *history of how it got there* — keep both, never silently overwrite history. Reserve \`events\` for dated happenings with no home entity (a launch, an outage).
8. **Truth format: structured markdown, not a wall of text.** Truth is a *summary of what is true now*, read by humans and re-read by future sessions — a one-line opening statement, then \`-\` bullets grouped under bold labels when there are multiple facets. One fact per bullet. Keep the whole truth under ~150 words (the \`user\` page under ~120); details, histories and one-off findings belong in timeline entries, not the truth. When merging, rewrite and CONDENSE — never concatenate the new fact onto the old text. If a new item does not fit the budget, it is probably not a standing fact.
`

/**
 * Every session of `definition` gets the standing rules ahead of its own
 * instructions. Applied at registration so no path that opens a session —
 * chat, workflow, assistant, channel — can forget them. The runtime passes
 * `instructions` to each agent's native channel (Claude's system-prompt
 * append, Codex developer instructions, an ACP preamble, …).
 */
export function withAgentPrompts<D extends AnyProviderDefinition>(definition: D): D {
  return {
    ...definition,
    create(ctx) {
      const provider = definition.create(ctx)
      const createSession = provider.createSession.bind(provider)
      provider.createSession = (params) =>
        createSession({
          ...params,
          instructions: [MEMORY_RESOLVER_PROMPT, FILE_REFERENCE_PROMPT, VISUAL_REPLY_PROMPT, params.instructions?.trim()]
            .filter(Boolean)
            .join('\n\n'),
        })
      return provider
    },
  }
}
