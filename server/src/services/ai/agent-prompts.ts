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
 * Whether to draw, and whether as an inline `ui` block or a page (`html_render`,
 * server/src/routes/visual-mcp.ts). Lives here and not only in the tool description: Claude defers MCP tools and
 * shows just their names, so the description is never read until the model
 * already decided to look the tool up. Layout and theme rules stay in the
 * description, loaded only when the tool is about to be used.
 */
export const VISUAL_REPLY_PROMPT = `## Visual replies

Answer in markdown by default. Draw only when the shape of the information is
the point and text would make the reader rebuild it in their head. Lists, a
single number and simple tables stay in markdown; code the user may copy stays
in code blocks. Only draw what you have confirmed from the code or sources.

Use a fenced \`ui\` block in your reply when one of these fits:
- Several key numbers to read at a glance: \`row\` with \`metric\`
- Values across categories: \`bar-chart\`
- Values over time: \`line-chart\`
- A process that branches, or a dependency graph: \`flow\`
- Layers read top to bottom: \`stages\`
- Options with trade-offs, when the reader must choose: \`compare\`
- Ordered steps with status or dates: \`timeline\`

Use \`html_render\` (\`mcp__visual__html_render\` under Claude runtime) only for
what those cannot do: a whole page, a game, an interactive walkthrough, a UI
mockup or a live visual effect. When \`html_preview\` is available, check the
page with it first and fix what it shows (empty or misplaced boxes, overlapping
text, console errors) before calling \`html_render\`. A .png the user wants to
send elsewhere is a file, not \`html_render\`.
`

/** Keep in step with UI_ICONS in src/lib/ui-block/catalog.ts. */
const UI_ICON_NAMES =
  'cloud, code, cpu, database, file, git, globe, layout, lock, message, package, search, server, shield, terminal, user, workflow, zap'

/** Syntax of the inline `ui` block; the catalog is src/lib/ui-block/catalog.ts. */
export const UI_BLOCK_PROMPT = `### \`ui\` blocks

A fenced code block with the language \`ui\` appears piece by piece as you write it.

Write one tag per line, and quote every attribute. These tags are all there is;
anything else is dropped, and there is no styling:

\`\`\`ui
<row columns="1">
  <metric label="Requests" value="1.2M" hint="last 7 days"/>
</row>
<bar-chart title="Latency" max="100" unit="ms">
  <bar label="US" value="42"/>
</bar-chart>
<flow title="Request path">
  <node id="client" label="Client"/>
  <node id="api" label="API" after="client"/>
  <node id="db" label="Database" after="api"/>
  <edge from="db" to="client"/>
</flow>
<stages title="Architecture">
  <stage icon="user" title="Browser" desc="Sends the request" tags="HTTP/2,TLS"/>
  <group title="Backend" columns="2" note="Share one database">
    <stage icon="server" title="API" desc="Validates input"/>
    <stage icon="database" title="Store" desc="Keeps the rows"/>
  </group>
</stages>
<compare title="Options" columns="2">
  <option title="REST" summary="Simple resources" badge="Recommended">
    <pro text="Easy to cache"/>
    <con text="Over-fetches"/>
  </option>
</compare>
<timeline title="Rollout">
  <step title="Migrate" desc="Add the new column" time="Mon" status="done"/>
  <step title="Release" time="Tue" status="active"/>
</timeline>
<line-chart title="Traffic" min="0" max="100" points="7" unit="%">
  <point label="Mon" value="42"/>
</line-chart>
\`\`\`

- \`row\` holds only \`metric\`; set \`columns\` (1 to 4) to the number of metrics it
  will hold. \`stack\` groups other blocks vertically.
- Always give \`bar-chart\` a \`max\` at least as large as its largest value.
- Write a \`node\` after its parents and name them in \`after\` (comma separated).
  Use \`edge\` only for a link \`after\` cannot express.
- \`stages\` is for layers read top to bottom, with a description on each; \`flow\`
  is for branching. \`icon\` is one of: ${UI_ICON_NAMES}.
- Set \`columns\` on \`group\` and \`compare\` (1 to 4) to how many items they will hold.
- \`step\` \`status\` is done, active, pending or failed.
- Always give \`line-chart\` \`max\` and \`points\` (2 to 60, how many it will hold).
`

export const MEMORY_RESOLVER_PROMPT = `## Memory

You have persistent memory across sessions: \`memory_search\` to read, \`memory_upsert\` to write.

Search before answering when the request depends on the user, a named person or project, or anything from past conversations. What memory returns was true when written, so verify file paths, function names and flags before acting on them.

Write when you learn something that will still matter in a different conversation weeks from now and cannot be found in the repo: who the user is, a rule they state in general terms, named people, services and projects in their world, dated decisions, lessons that took real effort to learn. Search first and extend the existing page. When a fact changes, record old → new.

Do not write what the repo already records (how the code is built, how a bug was fixed), one-off errors, this task's progress, or feedback on the current work. Never turn one remark into a trait.
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
          instructions: [MEMORY_RESOLVER_PROMPT, FILE_REFERENCE_PROMPT, VISUAL_REPLY_PROMPT, UI_BLOCK_PROMPT, params.instructions?.trim()]
            .filter(Boolean)
            .join('\n\n'),
        })
      return provider
    },
  }
}
