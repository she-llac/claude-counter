# Claude Counter

A minimal browser extension that shows token count, cache timer, and usage bars on claude.ai.

![Claude Counter screenshot](screenshot.png)

> Fork of [she-llac/claude-counter](https://github.com/she-llac/claude-counter) v0.4.2, updated for the claude.ai UI redesign (August 2026, 2.0.x) and for the new unified claude.ai interface (October 2026, 2.1.0).

## Features

- **Token count** — Approximate token count for the current conversation, with a mini progress bar against the 200k context limit
- **Cache timer** — Countdown showing how long the conversation remains cached (cheaper to continue)
- **Usage bars** — Session (5-hour) and weekly (7-day) usage from Claude's native API, with progress bars and reset countdowns

## Supported claude.ai interfaces

claude.ai is moving accounts to a new unified interface, and an account can be switched from one to the other.

| | Old interface | New interface |
| --- | --- | --- |
| Usage bars | `message_limit` in the `/completion` stream | limits in the `StreamTimeline` Connect stream |
| Token count, cache timer | conversation read when the page loads it | conversation read by the extension, again after every reply |

Both methods run side by side; whichever the page uses is picked up.

## What's new in 2.1.0 (the new unified claude.ai interface)

Details in the [changelog](CHANGELOG.md).

- **The new interface is supported**: the usage limits and the token count / cache timer are read from its `StreamTimeline` stream, next to the old `/completion` path; the bars move while a reply is still being generated
- **Usage bars persist across page reloads, tab changes and extension updates**: the saved snapshot is matched against every organisation id the page uses and restored again when the id becomes known later
- **0% and "no data yet" are told apart**: a window the server reports without a number is 0% (the server leaves a zero out), a window that was never reported says "no data yet"
- **A window that ended resets**: it shows 0% without the old value and a "resets in 0s" countdown, and fresh data is asked for at once
- **The token count and cache timer sit on a second line under the start of the chat title**, inside the title bar (the bar keeps its height), instead of squeezing the title or covering the chat; if the title is not found they stay above the usage bars
- `/usage` is no longer asked every second on plans where it reports nothing (free plan); failed requests back off up to an hour
- A limits event that the server sends again after the stream was re-opened is not counted as a new reply (it would restart the cache timer without any work)
- A chat whose parent links form a loop no longer hangs the token count
- Tests: `npm test` (Node 22, no dependencies)

## What's changed in 2.0.x (from upstream v0.4.2)

The update for the August 2026 claude.ai redesign, by [hey-naf](https://github.com/hey-naf/claude-counter):

- Fixed broken selectors after claude.ai's UI redesign (`chat-title-split`, `bg-surface-3`)
- Usage bars now render inside the rounded composer box
- Bars persist across page refreshes via `chrome.storage.local` (2.1.0 extends this, see above)
- Bars always visible with 0% fallback (free plan returns nulls until first message; 2.1.0 tells 0% from "no data yet")
- Org-scoped usage snapshot with expired-window cleanup
- Version bumped to 2.0.2 with resilient DOM anchoring, direct fetch fallbacks, and CSP compatibility

## Installation

**Chrome / Edge / Chromium 111 or newer**

1. Download the zip of the latest version from [Releases](../../releases) and unzip it
2. Go to `chrome://extensions` and enable **Developer mode**
3. Click **Load unpacked** and choose the unzipped folder (the one with `manifest.json`)

To update, unzip the new version over the old folder and click the reload button of the extension on `chrome://extensions`. Firefox has not been tried with 2.1.0.

## How it works

- Intercepts Claude's API responses to read conversation data and usage info
- Uses a vendored tokenizer (`o200k_base`) for approximate token counting
- Uses Claude's `/usage` plus the live limits that come with every reply (the old `message_limit` event, or the limits of the new `StreamTimeline` stream) for accurate progress bars
- Where `/usage` reports nothing (free plan) the bars show "no data yet" until the first reply of a session brings the limits; an ended window shows 0%
- Watches for DOM changes to inject UI elements as you navigate

## Development

Load the repository folder with **Load unpacked** (Developer mode). Run the tests with `npm test` (Node 22, nothing to install).

## Privacy

- All data stays local — no external servers, no tracking
- Reads your `lastActiveOrg` cookie (or the organisation id the page itself uses) to query Claude's `/usage` endpoint
- Makes requests only to `claude.ai`

## Credits

- Original project by [she-llac](https://github.com/she-llac/claude-counter) (MIT)
- The 2.0.x update for the August 2026 claude.ai redesign comes from [hey-naf](https://github.com/hey-naf/claude-counter)'s fork (v2.0.2), which 2.1.0 builds on
- Token counting via [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) (MIT)
- Inspired by [Claude Usage Tracker](https://github.com/lugia19/Claude-Usage-Extension) by lugia19

## License

MIT — see [LICENSE](LICENSE)
