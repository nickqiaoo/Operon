# Canvas Workflow

## What is it

Canvas Workflow is a visual workflow editor that lets you build multi-step AI pipelines by connecting nodes on a canvas. You can chain multiple AI models together, pass outputs between them, and run the entire pipeline with one click.

## How it works

Under the hood, workflows are represented as a **DAG (Directed Acyclic Graph)**. When you execute a workflow, the engine analyzes dependencies between nodes and runs them in the optimal order — nodes without dependencies run in parallel, and downstream nodes start as soon as their inputs are ready.

The execution engine uses an **incremental wait-for-any** strategy: instead of waiting for all parallel nodes to finish before moving on, it picks up completed nodes one by one and immediately starts any newly unblocked downstream nodes. This ensures maximum parallelism.

## Node Types

### AI Node

The core processing node. It sends a prompt to an AI model and returns the response. You can configure:

- **Agent & Model** — which AI agent and model to use.
- **Mode** — the operating mode (varies by agent).
- **Prompt** — a template, see [Variables](#variables).

### AI Session Node

Continues a conversation with a parent AI node. Instead of starting a fresh chat, it reuses the parent's session context, enabling true multi-turn dialogue within a workflow. Right-click an AI node and select "Continue Session" to create one.

Each AI node can have at most one session child.

### Shell Node

Runs a shell command in the workspace and outputs its stdout. Use it for tests, linters, builds, `git` and anything else that should be deterministic and free. A non-zero exit fails the node by default; turn that off to keep going and get stderr appended to the output instead.

### Template Node

Renders a text template from upstream variables without calling a model. With no upstream it is simply a constant, which is how you start a workflow with a fixed prompt or setting. Use it to assemble prompts, format notifications, or merge the results of different branches (`{{ fixed or original }}`).

### Code Node

Runs a JavaScript function body against the upstream variables (`inputs`) and outputs the return value; objects and arrays become JSON that downstream nodes can read as data. It has no `require`, filesystem or network — use Shell or AI nodes for those.

### HTTP Node

Calls an API or webhook and outputs the response body. Method, URL, headers, body and auth are all templates, so you can write `{{ env.GITHUB_TOKEN }}` for secrets. JSON responses become data for downstream nodes. Non-2xx fails the node by default.

### End Node

Declares the workflow's outputs as key/value templates. When present, the run's outputs are exactly these (what a parent workflow receives); without one, the leaf nodes' outputs are used.

### Iteration (for each)

A group you drag other nodes into. It renders its **Items** template to a JSON array (or one item per line) and runs the body once per item, in parallel up to the configured concurrency. Inside, `{{ item }}` and `{{ index }}` are available alongside every variable from outside the group. Each round's **Result** template is collected into a JSON array as the group's output.

### Loop (until)

A group that runs its body repeatedly until the **Exit when** expression is true or the **Max rounds** cap is hit. **Loop variables** carry values across rounds: each has an initial template and a `next` template evaluated after every round, readable inside as `{{ loop.<name> }}`. The output gets `iterations` and `exhausted` fields added.

### Sub-workflow Node

Calls another workflow. Give it a list of variables (name → template); inside the child they are ordinary variables, so a row named `file` is `{{ file }}` there. The child's variable picker lists them under "From calling workflows" once a caller exists. The child's End node outputs become this node's output. Cycles are rejected when saving, and a workflow that others call cannot be deleted.

### Approval Node

Pauses the run and posts a request to the inbox (and your phone). Approve in the results panel to continue; reject fails the node and skips what follows. Optional timeout. A restart while waiting loses the run.

### If/Else Node

Each case is built row by row — a variable, an operator (is true, equals, contains, greater than, matches regex, …) and a value — joined with and / or; switch to "Write an expression instead" for anything the rows cannot say. Cases are evaluated in order and the run continues through the first one that is true, or through `else` when none match. Each case has its own output handle on the canvas. Nodes on branches that were not taken are marked **skipped**, and a node that only has skipped predecessors is skipped too. A node that merges branches runs as soon as any one branch reaches it.

## Structured output

An AI node can carry a JSON Schema. The reply must then be JSON that validates against it; invalid replies get a correction round in the same chat (2 by default). Downstream nodes read fields directly: `{{ review.passed }}`.

## Triggers

- **Run button** — manual.
- **Schedule** — create a cron job that runs the workflow.
- **Another workflow** — a Sub-workflow node runs this workflow with whatever variables the caller hands in.

## Variables

Every node's output is available to every node that runs after it, by node name: `{{ summary }}`. This is not limited to directly connected nodes — edges define order, names define access.

You rarely need to type these: every template field has a `{x}` button (or type `{{`) that lists what this node can reference, and once the workflow has run it also lists the fields inside each JSON output so you can insert `{{ review.passed }}` without remembering it. A name that no upstream node provides is flagged under the field, and a template with a syntax error is refused when saving, naming the node and field.

- Outputs that are JSON objects or arrays become data: `{{ review.passed }}`, `{{ files | length }}`.
- Skipped nodes are `undefined`, so `{{ a or b }}` picks whichever branch ran.
- `{{ env.MY_TOKEN }}` reads an environment variable configured in Settings, keeping secrets out of the workflow itself.
- Filters: `| tojson` serializes a value, `| lines` splits text into non-empty lines.
- Conditions in If/Else nodes use the same syntax without the braces: `review.passed and "FAIL" not in tests`.

## Failures

A failed node stops only its own downstream: independent branches keep running, and the run is marked as error once everything that could run has finished. Deterministic nodes have a timeout (30s for Shell, 10s for Code by default) and outputs are capped at 256KB.

## Usage

1. **Create** — click "New Workflow" in the sidebar.
2. **Add nodes** — use the node palette or right-click the canvas.
3. **Connect** — drag from one node's output handle to another's input handle.
4. **Configure** — click a node to edit its agent, model, and prompt.
5. **Execute** — click the run button. Node statuses update in real-time on the canvas.
6. **Monitor** — click a running AI node to watch the live conversation. View final results in the result panel.

Changes are auto-saved as you edit. You can also view the execution history of each workflow.
