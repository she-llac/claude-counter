# Privacy Policy — Claude Counter v0.5.0

Claude Counter is a browser extension that displays token usage and rate limit information on claude.ai. This document explains how the extension handles your data.

## Data Processing

All data processing occurs **entirely within your browser**. No data is ever transmitted to external servers.

| Data | Purpose | Stored? | Transmitted Externally? |
|------|---------|---------|------------------------|
| Conversation messages | Count tokens locally | In-memory only (cleared on navigation) | Never |
| Organization ID | Query your usage from claude.ai | Not stored | Sent to claude.ai only (your own session) |
| Usage statistics | Display session/weekly usage bars | Not stored | Never (read from claude.ai API) |
| Active model name | Determine correct input limit for token bar | Not stored | Never |

## What We Do NOT Do

- We do **not** collect any personal information
- We do **not** send data to any external servers, analytics services, or third parties
- We do **not** store conversation content to disk or persistent storage
- We do **not** read authentication tokens, passwords, or session cookies (only the organization ID cookie)
- We do **not** modify your conversations or API requests
- We do **not** track your browsing history
- We do **not** use remote code execution (`eval`, external scripts, or CDN-loaded code)
- We do **not** inject advertisements or affiliate links

## Permissions

The extension requests **zero browser permissions** — no `storage`, `tabs`, `webRequest`, or host permissions. It operates solely through content scripts scoped to `https://claude.ai/*`.

## Open Source

The complete source code is available for review at [github.com/she-llac/claude-counter](https://github.com/she-llac/claude-counter). You are welcome to audit the code.

## Contact

For privacy-related questions, please open a GitHub issue.
