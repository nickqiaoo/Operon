---
name: operon-spec
description: Use only when the user invokes /operon-spec or explicitly asks to use OperonSpec. Align on the request, then start a background design workflow for the user to review and approve.
---

<!-- OPERON_MANAGED_SPEC_SKILL -->

# OperonSpec

An OperonSpec turns a request into a signed design before any code is written.
Your part is the conversation: understand what the user wants well enough to
write a brief that carries all of it. Then `start_spec` hands the brief to a
background run where explorers map the code, two or more agents from different
families design it, a judge on another family scores them, a lead synthesizes
one design, a fresh "builder" checks it for gaps, and it is split into tickets.
The user approves the design on the spec card.

## 1. Align — interview until nothing is silently assumed

Your first message: one line saying they can skip the questions if they would
rather you just start, and ONE open question about a concrete moment — "what's
the moment you find yourself wishing this existed?". Their own words carry
intent your options can't.

Then work the decisions as a tree, in rounds:

- The **frontier** is every decision whose prerequisites are already settled.
  Ask the whole frontier in one round, numbered, each with your recommended
  answer, worded so "yes" accepts the recommendation. A question that depends on
  another open question this round waits for the next round.
- **Facts are your job, never the user's.** Anything the code, the repo, the
  docs or a tool can tell you, look up yourself (delegate to a sub-agent if it is
  big). Only questions whose answer is the user's decision go to them. While a
  lookup runs, ask the rest of the frontier anyway.
- **Find out which "how" choices they want to own** — platform, language,
  libraries, storage, where it lives. If they have views, talk them through; if
  they hand them over, you will pick sensible defaults and say so.
- **Play it back.** As soon as you understand one part, describe it back in a
  short paragraph, marking your guesses as guesses, and ask what is wrong or
  missing. Playback and questions alternate.
- **Watch the words.** If the project has a `GLOSSARY.md` or `docs/adr/`, read
  them first. When the user's term conflicts with the glossary, or an idea was
  already decided against in an ADR, say so right away.

You are done when the frontier is empty and the user confirms you understand.
Then tell them what happens next — agents will design it in the background,
roughly how long, and that they sign the design at the end — and ask to start.

## 2. Start the spec

Call `start_spec(title, brief)` once they agree. The brief is the ONLY thing the
designers will know about this conversation, so write it as if for a capable
engineer who was not here. Name files by repository-relative paths — the
designers work in their own checkout, not yours, so an absolute path points
them at the wrong copy. Use the user's language and exactly these sections:

```
## Intent        why it is wanted, who it is for, one concrete moment it matters
## Goals / Non-goals / Anti-goals
## Decided       what the user decided, including the "how" choices they own
## Delegated     what they left to the agents
## Constraints
## Open          questions deliberately left for the design
```

If the user named which agents to use, pass them as `candidates` (provider ids
such as `codex`, `opencode`, `grok`). They design it, and every other role is
filled from them too (plus this chat's own agent) — users name agents when the
others are off the table. If they also named a model for one, write that entry
as `provider:model` (e.g. `opencode:opencode/deepseek-v4.1-flash-free`); every
seat of that provider then runs on it. Otherwise leave it out: the default is two
agents from different families plus a judge from a third.

`start_spec` returns immediately. Tell the user it has started and that they can
watch every agent in the Workflow tab — then stop. Do not poll and do not wait.

## 3. When the run reports back

The run's result arrives in this chat as a `<workflow-result>` whose result has
an `operonSpec` object. Do what its `next` says:

- **`awaiting_answers`** — the design needs decisions only the user can make.
  Ask the listed `questions` in ONE message, most important first, each with your
  recommendation. When they answer, call
  `answer_spec_questions(task, answers)` with their answers numbered to match.
  Never answer on their behalf.
- **`awaiting_design`** — the design is ready. Summarize it in a few lines: the
  chosen shape, which candidate it was based on, anything the agents decided for
  them. Ask them to review it and approve it on the spec card or the task page,
  or request changes there with a comment. The buttons are labelled in the
  user's UI language — describe them, don't quote English labels. Never approve it
  yourself, and do not start implementing — approval creates the tickets.
- **the run failed** — explain what failed in plain words and offer to resume
  it from the spec card once the cause is fixed.

## Red flags

| Thought | Reality |
|---|---|
| "This is simple, I'll just start the spec" | Unclear intent produces a confident wrong design. Align first. |
| "I'll ask about the code structure" | That is a fact. Look it up. |
| "I'll put my own preferences in Decided" | Decided is what the user decided. Your defaults go nowhere — the designers make those calls. |
| "The brief can be short, they can read the chat" | They cannot. The brief is all they get. |
| "I'll check on the spec in a minute" | The result comes to you. Stop after starting. |
| "The user said the design looks fine, I'll approve it" | Approval is the user's click on the card, never yours. |
