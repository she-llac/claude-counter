(() => {
	'use strict';

	const CC_MARKER = 'ClaudeCounter';

	// Capture original fetch before anyone else can wrap it
	const originalFetch = window.fetch;
	const originalPostMessage = window.postMessage.bind(window);

	// Wrap history methods early to detect SPA navigation (before frameworks cache them)
	const originalPushState = history.pushState.bind(history);
	const originalReplaceState = history.replaceState.bind(history);

	history.pushState = function (...args) {
		const result = originalPushState(...args);
		window.dispatchEvent(new CustomEvent('cc:urlchange'));
		return result;
	};

	history.replaceState = function (...args) {
		const result = originalReplaceState(...args);
		window.dispatchEvent(new CustomEvent('cc:urlchange'));
		return result;
	};

	window.fetch = async (...args) => {
		const url = toAbsoluteUrl(args[0]);

		// Security: only intercept claude.ai URLs
		if (!url || !url.startsWith('https://claude.ai/')) {
			return originalFetch.apply(window, args);
		}

		const opts = args[1] || {};

		// Detect generation start (completion requests)
		if (url && opts.method === 'POST' && (url.includes('/completion') || url.includes('/retry_completion'))) {
			post('cc:generation_start', {});
		}

		const response = await originalFetch.apply(window, args);

		const contentType = response.headers.get('content-type') || '';
		if (contentType.includes('event-stream')) {
			handleEventStream(response);
		}

		// Catch conversation tree fetches
		if (url && url.includes('/chat_conversations/') && url.includes('tree=')) {
			const meta = getConversationMeta(url);
			if (meta) {
				handleConversationResponse(meta, response);
			}
		}

		return response;
	};

	function post(type, payload) {
		originalPostMessage({ cc: CC_MARKER, type, payload }, 'https://claude.ai');
	}

	function postResponse(requestId, ok, payload, error) {
		originalPostMessage(
			{
				cc: CC_MARKER,
				type: 'cc:response',
				requestId,
				ok,
				payload,
				error
			},
			'https://claude.ai'
		);
	}

	function toAbsoluteUrl(input) {
		try {
			if (typeof input === 'string') {
				// Use URL constructor for safe resolution (handles relative paths + subdomains)
				return new URL(input, 'https://claude.ai').href;
			}
			if (input instanceof URL) return input.href;
			if (input instanceof Request) return input.url;
		} catch {
			// Malformed URL — do not intercept
		}
		return '';
	}

	function getConversationMeta(url) {
		// /api/organizations/{orgId}/chat_conversations/{conversationId}
		const match = url.match(/^https:\/\/claude\.ai\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?]+)/);
		return match ? { orgId: match[1], conversationId: match[2] } : null;
	}

	async function handleConversationResponse({ orgId, conversationId }, response) {
		try {
			const cloned = response.clone();
			const data = await cloned.json();
			// Security: only pass fields needed for token counting
			const minimal = {
				chat_messages: Array.isArray(data?.chat_messages) ? data.chat_messages.map(m => ({
					uuid: m?.uuid,
					parent_message_uuid: m?.parent_message_uuid,
					sender: m?.sender,
					created_at: m?.created_at,
					content: m?.content,
					attachments: Array.isArray(m?.attachments) ? m.attachments.map(a => ({
						extracted_content: a?.extracted_content
					})) : undefined
				})) : [],
				current_leaf_message_uuid: data?.current_leaf_message_uuid
			};
			post('cc:conversation', { orgId, conversationId, data: minimal });
		} catch {
			// ignore parse failures
		}
	}

	async function handleEventStream(response) {
		// Performance fix: tee the body instead of clone() to avoid buffering entire SSE stream.
		// We only need `message_limit` events — read linearly and discard immediately.
		let reader;
		try {
			const cloned = response.clone();
			reader = cloned.body?.getReader?.();
			if (!reader) return;
			const decoder = new TextDecoder();
			let buffer = '';
			let foundLimit = false;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split(/\r\n|\r|\n/);
				buffer = lines.pop() || '';
				for (const line of lines) {
					if (!line.startsWith('data:')) continue;
					const raw = line.slice(5).trim();
					if (!raw) continue;
					try {
						const json = JSON.parse(raw);
						if (json?.type === 'message_limit' && json.message_limit) {
							post('cc:message_limit', json.message_limit);
							foundLimit = true;
						}
					} catch {
						// ignore non-JSON lines
					}
				}
				// Once we found the limit, cancel early — no need to read the rest of the stream
				if (foundLimit) {
					reader.cancel();
					break;
				}
			}
		} catch {
			// Stream error — clean up
		} finally {
			reader?.releaseLock?.();
		}
	}

	// Security: validate IDs to prevent path traversal
	function isValidId(id) {
		return typeof id === 'string' && id.length > 0 && id.length < 200 && /^[a-zA-Z0-9_-]+$/.test(id);
	}

	window.addEventListener('message', async (event) => {
		if (event.source !== window) return;
		if (event.origin !== 'https://claude.ai') return;
		const data = event.data;
		if (!data || data.cc !== CC_MARKER) return;
		if (data.type !== 'cc:request') return;

		const { requestId, kind, payload } = data;

		// Security: validate request kind
		const VALID_KINDS = new Set(['hash', 'usage', 'conversation']);
		if (!VALID_KINDS.has(kind)) {
			postResponse(requestId, false, null, 'Unknown request kind');
			return;
		}
		try {
			if (kind === 'hash') {
				const text = typeof payload?.text === 'string' ? payload.text : '';
				if (!text || !crypto?.subtle?.digest) {
					postResponse(requestId, false, null, 'Hash unavailable');
					return;
				}
				const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
				const bytes = new Uint8Array(buffer);
				const hash = Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
				postResponse(requestId, true, { hash }, null);
				return;
			}

			if (kind === 'usage') {
				const orgId = payload?.orgId;
				if (!orgId || !isValidId(orgId)) throw new Error('Invalid orgId');
				const res = await originalFetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
					method: 'GET',
					credentials: 'include'
				});
				const json = await res.json();
				postResponse(requestId, true, json, null);
				return;
			}

			if (kind === 'conversation') {
				const orgId = payload?.orgId;
				const conversationId = payload?.conversationId;
				if (!orgId || !isValidId(orgId) || !conversationId || !isValidId(conversationId)) throw new Error('Invalid orgId/conversationId');

				const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;
				const res = await originalFetch(url, {
					method: 'GET',
					credentials: 'include'
				});
				const json = await res.json();
				// Security: only pass fields needed for token counting
				const minimal = {
					chat_messages: Array.isArray(json?.chat_messages) ? json.chat_messages.map(m => ({
						uuid: m?.uuid,
						parent_message_uuid: m?.parent_message_uuid,
						sender: m?.sender,
						created_at: m?.created_at,
						content: m?.content,
						attachments: Array.isArray(m?.attachments) ? m.attachments.map(a => ({
							extracted_content: a?.extracted_content
						})) : undefined
					})) : [],
					current_leaf_message_uuid: json?.current_leaf_message_uuid
				};
				post('cc:conversation', { orgId, conversationId, data: minimal });
				postResponse(requestId, true, json, null);
				return;
			}

			throw new Error(`Unknown request kind: ${kind}`);
		} catch (e) {
			postResponse(requestId, false, null, e?.message || String(e));
		}
	});
})();
