# GitHub Integration

## What is it

Operon has two GitHub connections: the **GitHub App** for task pull requests and review-comment steering, and your local **GitHub CLI** login for pull requests opened from the review toolbar or [Assistant](assistant).

Both are shown in **Settings > GitHub**. They are separate connections; an App installation does not sign you in to `gh`.

## Configuration

### GitHub App

1. Sign in from **Settings > Remote** on the desktop.
2. In **Settings > GitHub**, click **Install GitHub App** and choose the account or organization and repositories it can access.
3. Use **Link GitHub account** when offered to identify the account acting through the integration.
4. Check **Repository coverage** to see which local projects have a covered GitHub remote.

The App supports task PRs and routing review comments back to the responsible agent. Manage repository access with **Manage on GitHub**.

### GitHub CLI

Install `gh` and run `gh auth login` on the desktop. Return to **Settings > GitHub** and click **Refresh** to check that it is installed and signed in.

Manual PRs use this same login. Operon does not ask you to paste a Personal Access Token into Settings.

## Usage: Create PR

After reviewing your changes:

1. Open **Create PR** from the review toolbar for a repository with a GitHub remote.
2. Enter a title, description, branch name, and base branch.
3. Confirm creation. Operon prepares the branch, commits pending changes when needed, pushes it, and opens the PR using `gh`.
4. Open the returned PR URL to review it on GitHub.

You can also ask Assistant to check PR status or create a PR in a selected workspace. Creating one can commit and push changes, so request it when the work is ready to share.

## Removing it

**Forget** removes an App installation from Operon's saved connections. To change or revoke the installation itself, use **Manage on GitHub**. The CLI's login is managed separately with `gh`.
