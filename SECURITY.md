# Security — Claude Counter v0.5.0

Claude Counter takes the security and privacy of its users seriously. This document describes the security architecture and measures implemented in the extension.

## Architecture

The extension consists of two execution contexts:

1. **Content Scripts** (isolated world) — Run in Chrome's content script sandbox, isolated from the page's JavaScript environment. Handle UI rendering, token counting, and state management.

2. **Bridge Script** (page world) — A minimal script injected into the page context to intercept Claude's API responses (fetch wrapper). Communicates with content scripts via `postMessage`.

## Security Measures

### Message Security
- All `postMessage` communication specifies `'https://claude.ai'` as the target origin (not wildcard `'*'`)
- All incoming messages are validated for `event.origin === 'https://claude.ai'`
- Message types are validated against a strict whitelist
- Request kinds are validated against a strict enum (`usage`, `conversation`, `hash`)
- Bridge requests are rate-limited to 30 per minute to prevent abuse

### Network Isolation
- The fetch wrapper **only processes** URLs starting with `https://claude.ai/`
- All other network traffic passes through completely untouched
- No external network requests are made by the extension
- API requests use the user's existing authenticated session — no credentials are stored or managed by the extension

### Data Minimization
- Conversation data passed through internal messaging is stripped to only the fields needed for token counting (message content, UUIDs, sender, timestamps)
- Metadata, settings, and other fields are discarded before internal transfer
- Content hashing uses the Web Crypto API (`crypto.subtle`) directly in the content script — no user text crosses the postMessage boundary for hashing
- In-memory caches are pruned when conversations change and cleared on navigation

### Input Validation
- Organization IDs and conversation IDs are validated against strict alphanumeric patterns before use in API URLs
- This prevents path traversal and injection attacks through crafted IDs

### Extension Hardening
- **Manifest V3** with zero browser permissions
- **Explicit Content Security Policy**: `script-src 'self'; object-src 'none'`
- **Dynamic URLs** for web-accessible resources to prevent extension fingerprinting
- **No remote code**: All code is bundled locally, no CDN or external script loading
- **No eval()**: No dynamic code execution of any kind
- **Native API capture**: References to `fetch` and `postMessage` are captured before page scripts can wrap them
- **Safe URL resolution**: Uses `new URL()` constructor for path resolution instead of string concatenation
- **SSE stream optimization**: Early cancellation of cloned response streams after extracting needed data, with explicit `releaseLock()` cleanup to prevent memory growth
- **WCAG AA compliance**: All injected text meets 4.5:1 contrast ratio requirements
- **Layout isolation**: Injected elements use CSS `contain: layout style` to prevent affecting page performance

### Resilience
- Three-layer DOM discovery (exact selectors → structural heuristics → floating fallback) ensures the UI survives Claude.ai updates
- API response normalization absorbs format changes without breaking the extension
- All external dependencies are self-contained — graceful degradation if any component fails

## Threat Model

| Threat | Mitigation |
|--------|------------|
| Malicious iframe intercepting data | postMessage origin restricted to claude.ai |
| XSS on claude.ai accessing extension data | Content scripts run in isolated world; bridge data is minimized |
| Other extensions tampering with fetch | Native fetch reference captured before wrapping |
| Path traversal via crafted IDs | Input validation with strict regex |
| API abuse through bridge | Rate limiting (30 req/min) |
| Extension fingerprinting | Dynamic URLs for web-accessible resources |
| Developer account compromise | Open source — users can audit and build from source |
| Memory exhaustion via SSE streams | Early stream cancellation + explicit reader cleanup |

## Reporting Security Issues

If you discover a security vulnerability, please report it responsibly by opening a GitHub issue or contacting the maintainers directly. Please do not disclose vulnerabilities publicly until they have been addressed.

## Acknowledgments

Security hardening informed by analysis of real-world browser extension attacks including the Cyberhaven supply chain compromise (Dec 2024), the TamperedChef campaign (2025), and the 108 Extensions coordinated attack (April 2026).
