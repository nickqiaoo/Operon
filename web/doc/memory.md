# Memory

## What is it

Memory gives agents long-term context about you and your projects: preferences, people, decisions, and past work that can be recalled across conversations. It is separate from [Assistant](assistant)'s editable profile memory and daily notes.

Memory is available in builds that include it. If **Settings > Memory** is absent, this library is not enabled in that build.

## How it works

Each topic has one page with a current summary and a timeline of why that understanding changed. Agents can search older context and save new facts without creating a separate page for every mention.

Operon provides two tools:

- **`memory_search`** — finds relevant pages and recent timeline context, using keywords and semantic similarity.
- **`memory_upsert`** — saves facts with a reason. When a similar page exists, the agent must reconcile it before updating or creating a page.

### Reconciliation

Related facts are merged into the existing topic where appropriate. The current summary is rewritten to reflect what is true now, while the timeline keeps the history. If a result is out of date, tell the agent what changed.

### User memory

Facts about you, including your preferences, belong to a single **User** page. Named projects, people, and services have their own pages.

### Storage

Pages and search indexes are stored locally on the desktop. Embeddings are generated locally too. Recalled information becomes context for the agent you are using, so that context follows the selected model provider's data path.

## Memory categories

- **User** — your role, background, preferences, and working style.
- **Entities** — people, projects, services, and other named things.
- **Events** — dated happenings, decisions, and milestones.
- **Cases** — investigations, resolutions, and reusable workflows.

## Managing memories

### Browsing

1. Open **Settings > Memory**.
2. Switch to the **Memory** sub-tab. Review pages with their category and current summary; expand one to read its timeline.
3. Use search to find related context, or filter by category.

### Deleting

Deleting a page removes its summary, timeline, and search vectors. The topic can be saved again if it comes up in a later conversation.

## Maintenance

In **Settings > Memory > Maintenance**, choose an agent, model, and daily run time to extract missed memories from recent conversations. You can run it manually, cap the number of chats scanned, and inspect recent runs and logs.

## Embedding configuration

Semantic search needs the local embedding model.

1. Open **Settings > Memory** and select **Embedding**.
2. Download **Qwen3-Embedding-0.6B**.
3. Check the available acceleration and test the model once downloaded. CPU fallback is available.

Keyword search and semantic search complement each other; the embedding model does not replace the model selected for your conversations.
