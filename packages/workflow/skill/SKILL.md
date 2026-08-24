---
name: operon-workflow
description: Author and run JavaScript workflows that orchestrate sub-agents with agent(), parallel(), pipeline(), phases, structured output, background execution, and resume. Use when the user asks to run a workflow, fan out work, coordinate multiple agents, or invokes this skill from the slash menu.
---

<!-- OPERON_MANAGED_WORKFLOW_SKILL -->

# Operon Workflow

Use the `OperonWorkflow` MCP tool to execute a deterministic JavaScript workflow over
multiple sub-agents. Call it only when the user asks for multi-agent orchestration
or explicitly invokes this skill.

**Before the first call: ask the user which agent AND which model each step uses.**
Every `agent()` names an `agentType` and a `model`, neither has a default, and the
tool will not start until you pass `agents_chosen_by_user: true`. Call
`ListAgentModels` for the choices. See "Choosing an agent and a model" below.

## There may be two workflow tools

Your own agent may ship a built-in workflow tool as well. It is a different tool:
it runs everything inside your agent, while this Operon one spreads the work
across the other agents the user has installed and reports into Operon's panel.

Ask the user which one they want. Do not pick for them.

## Quick start

Pass a self-contained JavaScript program in the tool's `script` input:

```js
export const meta = {
  name: 'ping-pong',
  description: 'Return ping and pong',
  phases: [{ title: 'Run agents' }],
}

phase('Run agents')
const [ping, pong] = await parallel([
  // `phase` on each agent is what puts it in the group; phase() only declares one.
  () => agent('Return exactly ping', { agentType: 'codex', model: 'default', label: 'ping', phase: 'Run agents' }),
  () => agent('Return exactly pong', { agentType: 'claude-code', model: 'default', label: 'pong', phase: 'Run agents' }),
])

return `${ping}/${pong}`
```

Workflows always run in the background. The tool returns a `runId` at once, Operon
streams progress and each sub-agent's output into the Workflows panel, and when the
run finishes its result is delivered back to this conversation on its own.

So: tell the user what you launched, then carry on or stop. Do not wait for it, do
not poll for it, and do not treat the immediate return as "it didn't run".

## Tool inputs

- `script`: Inline JavaScript workflow. Required unless resuming a persisted run.
- `agents_chosen_by_user`: **Required (`true`) to start a run.** Set it only
  after the user has told you which agents to use. The tool refuses to start
  otherwise.
- `args`: Optional JSON value exposed to the script as the global `args`.
- `resumeFromRunId`: Resume an interrupted run. Omit `script` to reuse its saved
  script and omit `args` to reuse its saved arguments.

There is no foreground mode: a workflow is minutes of work across several agents,
which no MCP client will hold a single call open for.

## Script metadata

Every script must begin with a pure-literal `meta` export:

```js
export const meta = {
  name: 'review',
  description: 'Review several areas in parallel',
  phases: [
    { title: 'Review', detail: 'Inspect each area' },
    { title: 'Synthesize', detail: 'Combine the findings' },
  ],
}
```

`name` and `description` are required. `phases` is optional, but when present it
must be an array of objects with `title` fields. Use the same titles in `phase()`
calls AND in each agent's `phase` option — the option is what groups the agent.

## Runtime APIs

### `agent(prompt, options?)`

Spawn one sub-agent and wait for its result:

```js
const result = await agent('Inspect authentication error handling', {
  agentType: 'codex',
  model: 'gpt-5.6-sol',
  label: 'auth review',
  phase: 'Review',
})
```

The first argument must be a prompt string. Never pass an object such as
`agent({ prompt: '...' })`.

Supported options:

- `label`: Human-readable progress label.
- `phase`: Progress group for this agent. This — not a preceding `phase()` call —
  is what actually files the agent under that group in the panel.
- `schema`: JSON Schema for structured output.
- `agentType`: **Required.** Which agent runs this sub-agent — see "Choosing an
  agent" below. There is no default, and the choice is the user's to make.
- `model`: **Required.** Which model this sub-agent runs on — an id from
  `ListAgentModels`, or `'default'` to accept whatever that agent is already
  configured to use. Like `agentType`, there is no implicit default and the
  choice is the user's; see "Choosing an agent and a model" below.
- `isolation: 'worktree'`: Give a file-mutating agent an isolated git worktree.
  Use it when parallel agents would otherwise edit the same working tree.

Without `schema`, `agent()` returns the sub-agent's final text as a string. With
`schema`, it returns the parsed JSON value after validation.

### Choosing an agent and a model — ask the user, every time

This is what makes Operon's workflow different from a single-model one: every
`agent()` call can land on a DIFFERENT coding agent — each with its own CLI,
session, model, and account.

That choice belongs to the user, not to you. It decides whose account and quota
the work is spent from, and which model actually does it.

**Ask before you run.** Call `ListAgentModels` to get the agents available here
and the models each one can run. Show the user both lists, say which you would use
for which step and why, and let them decide. Only then call the tool with
`agents_chosen_by_user: true`. Without that flag the tool refuses to start — the
question is not optional and picking silently is not an option.

**There is no default agent and never will be.** Every `agent()` call must name an
`agentType`. A script that omits it is rejected before the run starts; an
unrecognized id fails that sub-agent rather than quietly running somewhere else.

**The same goes for the model.** Every `agent()` must also name a `model`. A script
that never mentions one is rejected, and the rejection carries the catalog so you
can ask the user straight away. `model: 'default'` is a valid answer — it means the
user is happy with whatever that agent is already configured to run — but it has to
be an answer, not an omission. This matters because the model decides both the
quality and the cost of a step, and the fallback is a constant baked into each
provider, not anything the user chose.

The available ids are installation-specific. Read the `OperonWorkflow` tool's own
description — it lists the ids configured on this machine (some subset of `codex`,
`claude-code`, `gemini`, `grok`, `kimi`, `opencode`, `cursor`, `copilot`, and
`operon`).

**`operon` is the app's own in-built agent — use it only when the user explicitly
asks for it.** Prefer the real coding agents. A workflow whose every step runs on
`operon` gains nothing over just doing the work yourself: same model, no second
opinion, no separate quota, only overhead.

```js
const [a, b] = await parallel([
  () => agent('Review the auth flow for logic errors', { agentType: 'codex', model: 'gpt-5.6-sol', label: 'codex' }),
  () => agent('Review the auth flow for logic errors', { agentType: 'claude-code', model: 'default', label: 'claude' }),
])
```

Choose deliberately: a provider's particular strengths for the task, genuinely
independent second opinions (different agents, not the same one twice), or
spreading long work across separate accounts and quotas.

### `parallel(thunks)`

Run independent agents concurrently. The argument must be an array of functions:

```js
const results = await parallel(
  targets.map((target) => () =>
    agent(`Review ${target}`, { agentType: 'codex', model: 'default', label: `review:${target}`, phase: 'Review' })
  )
)
```

Do not pass promises or option objects directly. A failed thunk becomes `null`;
filter failed results before synthesis when appropriate.

### `pipeline(items, ...stages)`

Run every item through dependent stages without waiting for a global barrier
between stages:

```js
const results = await pipeline(
  targets,
  (target) =>
    agent(`Inspect ${target}`, {
      agentType: 'codex',
      model: 'default',
      label: `inspect:${target}`,
      phase: 'Review',
      schema: FINDING_SCHEMA,
    }),
  (finding, target) =>
    agent(`Verify this finding for ${target}: ${JSON.stringify(finding)}`, {
      agentType: 'claude-code',
      model: 'default',
      label: `verify:${target}`,
      phase: 'Verify',
      schema: VERDICT_SCHEMA,
    })
)
```

Each stage receives `(previousResult, originalItem, index)`. Prefer `pipeline()`
for multi-stage per-item work. Use `parallel()` as a barrier only when the next
step needs all preceding results.

### Progress and inputs

- `phase(title)`: Declare a progress phase. It announces the group; it does NOT
  capture the `agent()` calls that follow it. Give each agent the same title as
  its `phase` option, or the panel shows an empty phase with the agents beside it.
- `log(message)`: Emit a progress line.
- `args`: Read the JSON value passed through the tool input.

## Structured output

Declare JSON Schemas as plain JavaScript objects:

```js
const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'files'],
}

const finding = await agent('Find the relevant files', {
  agentType: 'codex',
  model: 'default',
  schema: FINDING_SCHEMA,
})
```

Pass arrays and objects through the tool's `args` input as real JSON, not as a
JSON-encoded string.

## Resume

Resume with the prior run ID:

```json
{
  "resumeFromRunId": "wf-example"
}
```

Completed `agent()` calls in the longest unchanged prefix are replayed from the
journal. Interrupted and changed calls run again. Keep scripts deterministic so
resume keys remain stable.

## Script constraints

- Write JavaScript, not TypeScript. Do not use type annotations, interfaces, or
  generics.
- Use `await` directly; the body runs in an async context.
- Do not use Node.js APIs, filesystem APIs, or dynamic imports.
- `Date.now()`, `new Date()`, and `Math.random()` are unavailable because they
  would make resume nondeterministic. Pass changing values through `args`.
- Return a JSON-serializable value or a string.

The MCP surface uses inline scripts. Do not rely on predefined workflow names,
script paths, nested workflow calls, token budgets, or a separate task-output
tool.
