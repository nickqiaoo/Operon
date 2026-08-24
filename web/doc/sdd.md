# Spec-Driven Development

## What is it

Spec-Driven Development (SDD) turns a task from a one-line title into a reviewable **change package**: a written spec, a technical plan, and acceptance criteria — with approval gates between each stage. It pulls agents back from "vibe coding" into a controlled loop: align on the design first, decompose it, execute, verify, then fold the result back into your project's living specification.

SDD is **opt-in per channel**. Channels that don't enable it behave exactly as before — no extra ceremony.

## Why use it

- The output of a discussion is a **signed-off design**, not a chat log.
- Each task becomes a structured, human- and machine-readable change package whose source of truth is **git files**, not a database row — so the spec lands in the same diff as the code.
- Stages have **gates**: nobody starts coding before the design is approved.
- When a change is done, its spec **sediments back** into a project-level living specification, so the next change starts from the current truth (brownfield-friendly).

## Turning it on

Enable SDD when you create or edit a channel. Once on, the channel's agents get the SDD prompt templates and a set of SDD tools; promoting a discussion into a task produces a managed change package instead of a plain task.

> SDD requires the project to be a git repository — the workflow models a "change" as a branch and writes spec/plan/acceptance as files under `.operon/` on that branch.

## The change package

A change has two levels, both shown on the task board:

- **Parent task (the change)** — holds `spec.md` (what & why + acceptance criteria), `plan.md` (technical approach + the list of sub-tasks), and `acceptance.md` (criteria expanded into a checklist). Written by the **lead author** — the agent that has the best context from the discussion.
- **Child tasks (plan items)** — each is one executable slice of the plan, carrying code on its own branch plus references to which plan item and which acceptance criteria it owns. Executors can be fresh agents — they inherit context by reading the spec and plan.

A small change is just a parent with no children. A large feature is one parent plus many children.

## The flow

1. **Discuss** — agents brainstorm in the channel and converge on what to build, then a lead author is chosen.
2. **Promote** — the discussion is promoted into a parent task. Operon cuts a change branch and opens a worktree.
3. **Spec** — the lead author writes `spec.md` from the live context. Unknowns are marked `[NEEDS CLARIFICATION]`. **Gate: a human approves the spec.**
4. **Plan & decompose** — the author writes `plan.md` and the plan items become child tasks. **Gate: plan approved.**
5. **Execute** — each child task runs on its own branch; siblings coordinate through the team inbox without touching each other's files.
6. **Verify** — an independent, read-only verifier runs the acceptance criteria and a consistency check. **Gate: a human signs off on acceptance.**
7. **Done & sediment** — the change merges to `main` and its spec deltas are applied into the project's living specification.

## Approval gates

Gates are enforced in the database, not just suggested in a prompt — an agent literally cannot move a task forward until the required artifact is approved. By default two gates require a human: approving the **spec** (the direction is the easiest thing to get wrong) and approving **acceptance** (whether something is truly done is a human call). The stages in between can be configured to auto-approve.

Gates are reversible: if execution reveals the spec was wrong, the task can step back, the author rewrites the spec, and it gets re-signed.

## In the task detail view

When a task is SDD-managed, its detail view shows a **spec / plan / acceptance** panel. From there you read each artifact (served straight from the change branch), see its draft/approved status, and approve it at the gate. If an approved artifact is later edited, drift detection flips it back to draft so it gets re-signed.

## Related

- [Tasks](tasks) — the board and execution layer SDD builds on.
- [Channels](channels) — where SDD discussions happen.
