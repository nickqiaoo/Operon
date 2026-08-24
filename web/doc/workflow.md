# Canvas Workflow

## What is it

Canvas Workflow is a visual workflow editor that lets you build multi-step AI pipelines by connecting nodes on a canvas. You can chain multiple AI models together, pass outputs between them, and run the entire pipeline with one click.

## How it works

Under the hood, workflows are represented as a **DAG (Directed Acyclic Graph)**. When you execute a workflow, the engine analyzes dependencies between nodes and runs them in the optimal order — nodes without dependencies run in parallel, and downstream nodes start as soon as their inputs are ready.

The execution engine uses an **incremental wait-for-any** strategy: instead of waiting for all parallel nodes to finish before moving on, it picks up completed nodes one by one and immediately starts any newly unblocked downstream nodes. This ensures maximum parallelism.

## Node Types

### Input Node

A simple text node. You write a prompt or any text content, and it passes that text to downstream nodes. Use it as the starting point of your workflow.

### AI Node

The core processing node. It sends a prompt to an AI model and returns the response. You can configure:

- **Agent & Model** — which AI agent and model to use.
- **Mode** — the operating mode (varies by agent).
- **Prompt** — supports template variables to reference upstream outputs:
  - `{{<nodeName>}}` — reference input by the source node's name (e.g. `{{summary}}`).

### AI Session Node

Continues a conversation with a parent AI node. Instead of starting a fresh chat, it reuses the parent's session context, enabling true multi-turn dialogue within a workflow. Right-click an AI node and select "Continue Session" to create one.

Each AI node can have at most one session child.

## Usage

1. **Create** — click "New Workflow" in the sidebar.
2. **Add nodes** — use the node palette or right-click the canvas.
3. **Connect** — drag from one node's output handle to another's input handle.
4. **Configure** — click a node to edit its agent, model, and prompt.
5. **Execute** — click the run button. Node statuses update in real-time on the canvas.
6. **Monitor** — click a running AI node to watch the live conversation. View final results in the result panel.

Changes are auto-saved as you edit. You can also view the execution history of each workflow.
