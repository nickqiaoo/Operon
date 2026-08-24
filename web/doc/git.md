# Git

Operon does not replace your git workflow — it removes the two steps that break your focus: writing the commit message, and switching to a terminal to push.

## Committing

Open the **Commit or push** dialog from the git controls. It shows the current branch and how many files changed.

- **Include unstaged changes** stages everything before committing, so you do not have to `git add` first.
- **Commit message** is where the useful part happens: leave it empty and Operon writes one for you from the staged diff.
- **Next steps** picks what actually runs — commit, commit and push, or push only. **Force push** appears when pushing.

## Generated commit messages

When the message box is empty, Operon asks a model to write one from the staged diff.

Configure it under **Settings > Commit message generation**: pick the provider and model to use. The model runs headlessly with the diff inlined — no tools, no file access, nothing but the diff and one request. It is deliberately a small, fast job, so it is worth pointing at a cheap model rather than your main coding one.

If you type a message yourself, no model is called at all.

## Reviewing before you commit

The **Review** panel tab shows the working diff. Reviewing there and committing from the dialog is the usual loop after an agent finishes a change — you read what it actually did, then commit it under your own name.
