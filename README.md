# Claude Counter

A minimal browser extension that shows token count, cache timer, and usage bars on claude.ai.

![Claude Counter screenshot](./screenshot.png)

## Features

- **Usage notifications** — Browser notifications when session or weekly usage crosses 50%, 75%, and 90%
- **Reset countdown alerts** — Notified 1 hour and 30 minutes before your session resets if you still have capacity remaining (skipped if usage is above 90%)
- **Session reset alert** — Notified when your session resets so you know you have 100% available again
- **Bell toggle** 🔔 — Click to enable/disable notifications, persists across sessions

## Installation

**Chrome / Edge / Chromium**

1. Download [`claude-counter-0.4.2.zip`](../../releases/download/v0.4.2/claude-counter-0.4.2.zip)
2. Go to `chrome://extensions` and enable **Developer mode**
3. Drag and drop the zip onto the page

**Firefox**

1. Download [`claude-counter-0.4.2.xpi`](../../releases/download/v0.4.2/claude-counter-0.4.2.xpi)
2. Drag it into any Firefox window and click **Add**

**Userscript**

1. Install the userscript from [`claude-counter.user.js`](./userscript/claude-counter.user.js)

## How it works

- Intercepts Claude's API responses to read conversation data and usage info
- Uses a vendored tokenizer (`o200k_base`) for approximate token counting
- Uses Claude’s `/usage` plus live SSE `message_limit` data; the SSE provides exact, unrounded utilization fractions, so the progress bars are more accurate than the rounded percentages shown on Claude’s native /usage page
- Watches for DOM changes to inject UI elements as you navigate

## Privacy

- All data stays local — no external servers, no tracking
- Reads your `lastActiveOrg` cookie to query Claude's `/usage` endpoint
- Makes requests only to `claude.ai`

## Credits

- Token counting via [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) (MIT)
- Inspired by [Claude Usage Tracker](https://github.com/lugia19/Claude-Usage-Extension) by lugia19

## License

MIT
