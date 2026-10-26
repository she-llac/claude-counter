# Changelog

All notable changes to the Claude Counter extension will be documented in this file.

## [2.1.0] - 2026-10-24

### Added
- **New claude.ai interface (unified UI)**: replies in the new interface arrive on a Connect stream (`ConversationService/StreamTimeline`) instead of the old `/completion` stream. The usage limits (5-hour and 7-day windows) are now read from that stream by field number, so the session and weekly bars update after every reply. The old `message_limit` path is unchanged and still used where claude.ai serves the old interface.
- **Token count and cache timer in the new interface**: the end of a reply (`cc:turn_end`) triggers a new read of the conversation, retried while the server has not stored the new messages. The cache window gets a provisional end from the end of the reply. If the header anchor is missing or the header is not visible, the token count and cache timer are placed next to the chat title, found by the title's own text (the title comes from the conversation read, or from the page title). They go into the bar that holds the title, on a second line under the start of the title (out of the row, taking no room from the title or the buttons; the bar is as high as before). The position follows the title when the page moves it. If that does not work, or the title is not found, they are shown above the usage bars.
- Requires Chrome 111 or newer (`minimum_chrome_version`).
- **Tests**: `npm test` (Node 22, no dependencies) runs the real extension files against recorded frames, a fake DOM and a manual clock.

### Fixed
- **`/usage` asked every second** on plans where it reports nothing (free plan). A valid answer (even an empty one) is now repeated after an hour; a failed request is retried after a minute, then after 2, 4, 8 … minutes, at most hourly. A saved snapshot whose window has ended asks for fresh data at once.
- **Stale value after a window ended**: an ended window shows 0% without a countdown instead of the old value with "resets in 0s". A window that was never reported shows "no data yet".
- **Usage bars empty after opening a page**: the saved usage was matched to the organisation by cookie only, which is unreadable for some accounts. It is now matched like every request, restored again when the organisation becomes known later, and no longer deleted when `/usage` reports nothing.
- **Usage bars after a reload in the new interface**: a saved snapshot is matched against every organisation id seen on the page, filled in only for the windows still missing (a limits event is not overwritten), and restoration is retried every ten seconds for the first two minutes.
- A limits event or `/usage` answer with only one window no longer wipes the other one.
- A chat whose parent links form a loop no longer hangs the token count.
- A window reported without a number (the server leaves out 0.0) shows 0%, not nothing.
- A limits event the server sends again after the stream was re-opened is not taken for a new reply (events are told apart by their id; comparing the limits would not do, they are rounded to whole percent): it neither restarts the cache timer nor triggers a conversation read.
- An error answer to a conversation request is a failure again, not an empty chat. Several reply ends in a row start only one follow-up read.

### Changed
- The `PerformAction` call of the new interface is not treated as the start of a reply (the page also calls it when a chat is opened and while typing).

## [2.0.2] - 2026-09-03

### Fixed
- **Uncaught TypeError on `document.body`**: Fixed `Cannot read properties of null (reading 'appendChild')` by defensively mounting tooltips (`makeTooltip`), safely starting `MutationObserver` on `document.body || document.documentElement` (or upon `DOMContentLoaded`), and configuring UI content scripts to run at `document_idle`.

## [2.0.1] - 2026-09-03

### Fixed
- **Composer Mounting & Modern UI Anchoring**: Decoupled usage line mounting from `[data-testid="model-selector-dropdown"]` and `[data-cds="ChatComposer"]`. The usage bar now directly anchors to `[data-testid="chat-input"]` and mounts seamlessly inside `.bg-surface-3` after the flow child on both the home/new chat view and conversation view.
- **Header Token Counter Anchoring**: Added multi-selector support for header title elements (`chat-title-split`, `chat-title-button`, `conversation-title`) so token counts and cache timers reliably render across various page states and updates.
- **Unhandled Storage Promise Crash**: Wrapped `chrome.storage.sync` check in `main.js` with comprehensive try/catch and fallback to avoid silent crashes on initial load when sync storage is unavailable.
- **Direct Fetch Fallbacks**: Added direct content script `fetch()` fallbacks for `/usage`, `/chat_conversations/{id}`, and `/organizations` when the bridge client is delayed or blocked by CSP.
- **Active Org ID Resolution**: Implemented multi-tier active organization resolution checking memory, cookies (`lastActiveOrg`), local storage, extension storage, and querying `/api/organizations` directly.
- **Content Security Policy (CSP) Compatibility**: Declared `src/injected/bridge.js` with `"world": "MAIN"` in `manifest.json`, eliminating failures caused by DOM `<script>` tags blocked by `script-src`.
- **Local Web Crypto Token Hashing**: Added direct `crypto.subtle.digest` in content script context to accelerate token cache fingerprinting without requiring bridge message-passing.

## [2.0.0] - 2026-08-20

### Added
- Forked and updated for claude.ai UI redesign.
- Usage bars rendered inside rounded composer box.
- Local storage persistence for session and weekly usage state.
