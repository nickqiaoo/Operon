# Spec-Driven Development

## What is it

Spec-Driven Development (SDD) turns a discussion into a reviewable **change package**: a spec, a plan when needed, and an acceptance report after implementation. You approve the design before agents start coding, then review the result before marking it done.

SDD is opt-in for each change. Ask an agent in a workspace chat or channel to turn the agreed design into a spec-driven task; there is no channel-wide switch.

## Why use it

- The design is written down and reviewed before implementation.
- Specs and plans live in git alongside the code.
- Server-enforced gates keep implementation behind design approval and completion behind your review.
- Finished changes can be folded into the project's living specification.

## Turning it on

Discuss the change, settle open questions, and ask the agent to create a spec-driven task. It appears on the project board with its own branch and workspace. The author writes the spec and plan, then hands it back to you.

> SDD requires a git repository. Read the artifacts in task details before using **Dispatch** to sign off the design and start work.

## The change package

Both levels appear on the task board:

- **Parent task** — holds the spec and plan. The spec includes acceptance scenarios; the acceptance artifact is a verifier's report written later, after implementation.
- **Child tasks** — slices of the approved plan, each with a branch and the acceptance criteria it owns. They inherit context from the spec and plan.

A tiny change can omit the plan and children and run as one task.

## The flow

1. **Discuss** — align on requirements in a workspace chat or channel.
2. **Create** — the agent creates a spec-driven parent task with its own change workspace.
3. **Spec and plan** — the author documents the design, resolves clarification markers, and writes the execution plan. It does not write the acceptance report up front.
4. **Dispatch** — you approve the design by pressing **Dispatch**, choose executors, and start work. Plan items become child tasks.
5. **Execute** — ordered plan items run in waves; independent items can run together. Completed child work merges into the change branch before dependent work starts. Explicit coordination groups can use a team inbox.
6. **Verify and review** — at review time, choose an independent verifier or explicitly sign off without one. A verifier writes the acceptance report; you decide whether the change is ready.
7. **Done and sediment** — marking Done signs off acceptance, applies a specification delta when one exists, and merges the change into the project's default branch. Conflicts block completion; signing off without a verifier is recorded explicitly.

## Approval gates

**Dispatch** signs off the spec and plan and prepares their tasks together. Unresolved clarification markers block spec approval. Agents hand completed work back for human review rather than marking their own task Done.

Approved artifacts are checked for later edits. A changed artifact returns to draft and needs sign-off again; child tasks must finish before their parent can complete.

## In the task detail view

The **spec / plan / acceptance** panel shows the artifacts and their status. Dispatch is the design approval action. At review time you can run a verifier and inspect its report; **Preview sediment** and **Apply sediment** let you inspect and apply living-spec updates. Conflicts need resolution before applying.

## Related

- [Tasks](tasks) — the board and execution layer.
- [Channels](channels) — shared discussions that can produce a change.
