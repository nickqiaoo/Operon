# Tab Claiming
- To take over an already-open Chrome tab, call `browser.user.openTabs()`, choose the matching returned tab by its visible title, URL, recency, and tab group, then pass that exact object to `browser.user.claimTab(tab)`.
- Claiming gives the current browser session control of the chosen Chrome tab without moving it into an agent tab group, and returns a normal controllable `Tab`. Reuse that returned tab for navigation, Playwright, screenshots, CUA, and content reads.
- Do not guess tab ids. Only claim ids that came from the current `openTabs()` result.
