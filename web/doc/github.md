# GitHub Integration

## What is it

The GitHub integration accepts a Personal Access Token used specifically to power the desktop's **Create PR** feature — once you've made changes in the editor, one click lets Operon create a branch and a pull request through the GitHub REST API directly, without you switching to the terminal to run `git` and `gh`.

> The token's scope is **limited to the Create PR flow**: verifying your login, fetching repo metadata (default branch, fork status, etc.), and calling `POST /repos/.../pulls` to create the PR. It is **not** injected into any AI agent as `gh` CLI authentication, and it has **nothing to do** with Operon's AI-written commit messages (that capability only reads the local diff and calls your existing AI Provider — it does not depend on the GitHub token).

## Configuration

1. Generate a [Personal Access Token](https://github.com/settings/tokens) on GitHub. Create PR needs at least `repo` (required for private repos); for public repos `public_repo` is enough.
2. Open Operon **Settings → GitHub**.
3. Paste the token into the input and click Save.
4. On success, the card shows the logged-in GitHub username (from `GET /user`) — that account becomes the author of subsequent PRs.

The token is encrypted at rest on the desktop and is never sent to any external server.

## Usage: Create PR

After editing files, saving, and reviewing the diff:

1. Click the **Create PR** button in the top-right of the editor (only visible when Operon recognizes the current repo as having a GitHub remote).
2. In the dialog, fill in:
   - **Title** — PR title.
   - **Description** — PR body.
   - **Branch name** — defaults to a temporary `ai/<slug>-<MMDD>` style name; editable.
   - **Base branch** — target branch (defaults to the repo's default branch).
3. Click Create. Operon will:
   - Create the branch in the current repo and push the changes.
   - Call the GitHub API to open the PR.
   - Show the PR URL in the dialog so you can open it with one click.

The whole thing works without `gh` CLI installed locally.

## Removing it

Click **Delete** in **Settings → GitHub** to clear the saved token. With no token, the Create PR button prompts you to configure one in Settings first.
