# User Tab Claiming
- To take over an already-open in-app browser tab, call `browser.user.openTabs()`, choose the matching returned tab by its visible title and URL, then pass that exact object to `browser.user.claimTab(tab)`.
- Claiming makes that existing tab part of the current Browser Use run and returns a normal controllable `Tab`. Reuse the returned tab for navigation, Playwright, screenshots, CUA, and content reads.
- Do not pass `openTabs()` ids to `browser.tabs.get(...)`. `browser.tabs.get(...)` only resolves tabs that the current Browser Use run is already controlling.
- Prefer claiming the existing in-app browser tab when the page you need is already open, instead of opening a duplicate tab to the same URL.
