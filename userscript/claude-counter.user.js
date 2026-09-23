// ==UserScript==
// @name         Claude Counter
// @namespace    https://github.com/she-llac/claude-counter
// @version      0.4.2-userscript
// @description  Shows token count, cache timer, and usage bars on claude.ai.
// @match        https://claude.ai/*
// @run-at       document-start
// @grant        none
// @require      https://unpkg.com/gpt-tokenizer@2.9.0/dist/o200k_base.js
// ==/UserScript==

(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__ccUserscriptWrapped) return;
	CC.__ccUserscriptWrapped = true;

	CC._ccInternal = CC._ccInternal || {};
	CC._ccInternal.onGenerationStart = CC._ccInternal.onGenerationStart || (() => {});
	CC._ccInternal.onConversationData = CC._ccInternal.onConversationData || (() => {});
	CC._ccInternal.onMessageLimit = CC._ccInternal.onMessageLimit || (() => {});
	CC._ccInternal.onUrlChange = CC._ccInternal.onUrlChange || (() => {});

	const originalFetch = window.fetch ? window.fetch.bind(window) : null;
	CC._ccInternal.originalFetch = originalFetch;

	const originalPushState = history.pushState.bind(history);
	const originalReplaceState = history.replaceState.bind(history);

	const dispatchUrlChange = () => {
		try {
			CC._ccInternal.onUrlChange();
		} catch {
			// ignore
		}
	};

	history.pushState = function (...args) {
		const result = originalPushState(...args);
		dispatchUrlChange();
		return result;
	};

	history.replaceState = function (...args) {
		const result = originalReplaceState(...args);
		dispatchUrlChange();
		return result;
	};

	window.addEventListener('popstate', dispatchUrlChange);

	if (originalFetch) {
		window.fetch = async (...args) => {
			const url = toAbsoluteUrl(args[0]);
			const opts = args[1] || {};
			const method = (opts.method || 'GET').toUpperCase();

			if (url && method === 'POST' && (url.includes('/completion') || url.includes('/retry_completion'))) {
				try {
					CC._ccInternal.onGenerationStart();
				} catch {
					// ignore
				}
			}

			const response = await originalFetch(...args);
			const contentType = response.headers.get('content-type') || '';
			if (contentType.includes('event-stream')) {
				handleEventStream(response);
			}

			if (url && url.includes('/chat_conversations/')) {
				const method = (opts.method || 'GET').toUpperCase();
				if (method === 'GET') {
					const meta = getConversationMeta(url);
					if (meta) {
						handleConversationResponse(meta, response);
					}
				}
			}

			return response;
		};
	}

	function toAbsoluteUrl(input) {
		if (typeof input === 'string') {
			if (input.startsWith('/')) return `https://claude.ai${input}`;
			return input;
		}
		if (input instanceof URL) return input.href;
		if (input instanceof Request) return input.url;
		return '';
	}

	function getConversationMeta(url) {
		const match = url.match(/^https:\/\/claude\.ai\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?]+)/);
		return match ? { orgId: match[1], conversationId: match[2] } : null;
	}

	async function handleConversationResponse({ orgId, conversationId }, response) {
		try {
			const cloned = response.clone();
			const data = await cloned.json();
			CC._ccInternal.onConversationData({ orgId, conversationId, data });
		} catch {
			// ignore parse failures
		}
	}

	async function handleEventStream(response) {
		try {
			const cloned = response.clone();
			const reader = cloned.body?.getReader?.();
			if (!reader) return;
			const decoder = new TextDecoder();
			let buffer = '';

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
							CC._ccInternal.onMessageLimit(json.message_limit);
						}
					} catch {
						// ignore
					}
				}
			}
		} catch {
			// best-effort; do not break claude.ai
		}
	}
})();

(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	CC.DOM = Object.freeze({
		CHAT_MENU_TRIGGER: '[data-testid="chat-menu-trigger"]',
		MODEL_SELECTOR_DROPDOWN: '[data-testid="model-selector-dropdown"]',
		CHAT_PROJECT_WRAPPER: '.chat-project-wrapper',
		CHAT_INPUT_CONTAINER: '[data-testid="chat-input-grid-container"]',
		CHAT_INPUT_AREA: '[data-testid="chat-input-grid-area"]',
		BRIDGE_SCRIPT_ID: 'cc-bridge-script'
	});

	CC.CONST = Object.freeze({
		CACHE_WINDOW_MS: 5 * 60 * 1000,
		CONTEXT_LIMIT_TOKENS: 200000
	});

	CC.COLORS = Object.freeze({
		PROGRESS_FILL_DARK: '#2c84db',
		PROGRESS_FILL_LIGHT: '#5aa6ff',
		PROGRESS_OUTLINE_DARK: '#787877',
		PROGRESS_OUTLINE_LIGHT: '#bfbfbf',
		PROGRESS_MARKER_DARK: '#ffffff',
		PROGRESS_MARKER_LIGHT: '#111111',
		RED_WARNING: '#ce2029',
		BOLD_LIGHT: '#141413',
		BOLD_DARK: '#faf9f5'
	});
})();



(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const ROOT_MESSAGE_ID = '00000000-0000-4000-8000-000000000000';

	function stableStringify(value) {
		const seen = new WeakSet();

		const normalize = (v) => {
			if (v === null || typeof v !== 'object') return v;
			if (seen.has(v)) return '[Circular]';
			seen.add(v);

			if (Array.isArray(v)) return v.map(normalize);

			const out = {};
			for (const key of Object.keys(v).sort()) {
				out[key] = normalize(v[key]);
			}
			return out;
		};

		try {
			return JSON.stringify(normalize(value));
		} catch {
			return '';
		}
	}

	function getTokenizer() {
		return globalThis.GPTTokenizer_o200k_base || null;
	}

	function countTokens(text) {
		if (!text) return 0;
		const tokenizer = getTokenizer();
		if (!tokenizer?.countTokens) return 0;
		try {
			return tokenizer.countTokens(text);
		} catch {
			return 0;
		}
	}

	function buildTrunk(conversation) {
		const messages = Array.isArray(conversation?.chat_messages) ? conversation.chat_messages : [];
		const byId = new Map();
		for (const msg of messages) {
			if (msg?.uuid) byId.set(msg.uuid, msg);
		}

		const leaf = conversation?.current_leaf_message_uuid;
		if (!leaf) return [];

		const trunk = [];
		let currentId = leaf;
		while (currentId && currentId !== ROOT_MESSAGE_ID) {
			const msg = byId.get(currentId);
			if (!msg) break;
			trunk.push(msg);
			currentId = msg.parent_message_uuid;
		}

		trunk.reverse();
		return trunk;
	}

	function isCountableContentItem(item) {
		if (!item || typeof item !== 'object') return false;
		if (typeof item.type !== 'string') return false;
		if (item.type === 'thinking' || item.type === 'redacted_thinking') return false;
		if (item.type === 'image' || item.type === 'document') return false;
		return true;
	}

	function stringifyCountableContentItem(item) {
		if (!isCountableContentItem(item)) return '';

		// Common fast-path for text blocks.
		if (item.type === 'text' && typeof item.text === 'string') return item.text;

		// Tool blocks: include observable payloads deterministically, but exclude "thinking".
		if (item.type === 'tool_use') {
			const minimal = {
				id: item.id,
				name: item.name,
				input: item.input
			};
			return stableStringify(minimal);
		}

		if (item.type === 'tool_result') {
			const minimal = {
				tool_use_id: item.tool_use_id,
				is_error: item.is_error,
				content: item.content
			};
			return stableStringify(minimal);
		}

		// Fallback: keep only known-ish textual fields to avoid pulling in huge binary-ish blobs.
		const minimal = {};
		if (typeof item.text === 'string') minimal.text = item.text;
		if (typeof item.title === 'string') minimal.title = item.title;
		if (typeof item.url === 'string') minimal.url = item.url;
		if (typeof item.content === 'string') minimal.content = item.content;
		if (Array.isArray(item.content)) minimal.content = item.content;
		if (Object.keys(minimal).length === 0) return '';
		return stableStringify(minimal);
	}

	function stringifyMessageCountables(message) {
		const parts = [];

		// Message content blocks (primary source for tools, text, etc).
		const content = Array.isArray(message?.content) ? message.content : [];
		for (const item of content) {
			const s = stringifyCountableContentItem(item);
			if (s) parts.push(s);
		}

		// Attachment extracted content (observable, already text).
		const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
		for (const a of attachments) {
			if (typeof a?.extracted_content === 'string' && a.extracted_content) {
				parts.push(a.extracted_content);
			}
		}

		return parts.join('\n');
	}

	async function hashString(str) {
		if (!crypto?.subtle?.digest) return null;
		try {
			const data = new TextEncoder().encode(str);
			const buffer = await crypto.subtle.digest('SHA-256', data);
			const bytes = new Uint8Array(buffer);
			// Use first 8 bytes (64 bits) for fingerprint
			return Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
		} catch {
			return null;
		}
	}

	async function fingerprint(text) {
		if (!text) return null;
		const hash = await hashString(text);
		if (!hash) return null;
		return `${text.length}:${hash}`;
	}

	class TokenCache {
		constructor() {
			this._byMessageId = new Map(); // uuid -> { fp, tokens }
		}

		async getMessageTokens(messageId, messageText) {
			const fp = await fingerprint(messageText);
			if (!fp) return countTokens(messageText);
			const cached = this._byMessageId.get(messageId);
			if (cached && cached.fp === fp) return cached.tokens;

			const tokens = countTokens(messageText);
			this._byMessageId.set(messageId, { fp, tokens });
			return tokens;
		}

		pruneToMessageIds(keepIds) {
			const keep = new Set(keepIds);
			for (const id of this._byMessageId.keys()) {
				if (!keep.has(id)) this._byMessageId.delete(id);
			}
		}
	}

	const tokenCache = new TokenCache();

	async function computeConversationMetrics(conversation) {
		const trunk = buildTrunk(conversation);
		const trunkIds = trunk.map((m) => m.uuid).filter(Boolean);
		tokenCache.pruneToMessageIds(trunkIds);

		let totalTokens = 0;
		let lastAssistantMs = null;

		for (const msg of trunk) {
			if (msg?.sender === 'assistant' && msg?.created_at) {
				const msgMs = Date.parse(msg.created_at);
				if (!lastAssistantMs || msgMs > lastAssistantMs) {
					lastAssistantMs = msgMs;
				}
			}

			const msgText = stringifyMessageCountables(msg);
			const msgTokens = msg?.uuid ? await tokenCache.getMessageTokens(msg.uuid, msgText) : countTokens(msgText);
			totalTokens += msgTokens;
		}
		const cachedUntil = lastAssistantMs ? lastAssistantMs + CC.CONST.CACHE_WINDOW_MS : null;

		return {
			trunkMessageCount: trunk.length,
			totalTokens,
			lastAssistantMs,
			cachedUntil
		};
	}

	CC.tokens = { computeConversationMetrics };
})();


(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	function formatSeconds(totalSeconds) {
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${String(seconds).padStart(2, '0')}`;
	}

	function formatResetCountdown(timestampMs) {
		// <= 0: reset time reached
		const diffMs = timestampMs - Date.now();
		if (diffMs <= 0) return '0s';

		// < 1 min: show seconds
		const totalSeconds = Math.floor(diffMs / 1000);
		if (totalSeconds < 60) return `${totalSeconds}s`;

		// < 1 hour: show minutes
		const totalMinutes = Math.round(totalSeconds / 60);
		if (totalMinutes < 60) return `${totalMinutes}m`;

		// < 1 day: show hours
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours < 24) return `${hours}h ${minutes}m`;

		// >= 1 day: show days
		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}d ${remHours}h`;
	}

	function formatLocalTime(timestampMs) {
		if (!timestampMs) return '';
		try {
			const date = new Date(timestampMs);
			const timeStr = date.toLocaleTimeString([], {
				hour: 'numeric',
				minute: '2-digit',
				hour12: true
			});

			const now = new Date();
			const isToday = date.getDate() === now.getDate() &&
				date.getMonth() === now.getMonth() &&
				date.getFullYear() === now.getFullYear();

			if (isToday) {
				return `@ ${timeStr}`;
			} else {
				const dayStr = date.toLocaleDateString([], {
					weekday: 'short',
					month: 'short',
					day: 'numeric'
				});
				return `on ${dayStr}, ${timeStr}`;
			}
		} catch {
			return '';
		}
	}

	function getFullLocalResetString(timestampMs) {
		if (!timestampMs) return '';
		try {
			const date = new Date(timestampMs);
			return date.toLocaleString([], {
				weekday: 'long',
				year: 'numeric',
				month: 'long',
				day: 'numeric',
				hour: 'numeric',
				minute: '2-digit',
				timeZoneName: 'long'
			});
		} catch {
			return '';
		}
	}

	function setupTooltip(element, tooltip, { topOffset = 10 } = {}) {
		if (!element || !tooltip) return;
		if (element.hasAttribute('data-tooltip-setup')) return;
		element.setAttribute('data-tooltip-setup', 'true');
		element.classList.add('cc-tooltipTrigger');

		let pressTimer;
		let hideTimer;

		const show = () => {
			const rect = element.getBoundingClientRect();
			tooltip.style.opacity = '1';
			const tipRect = tooltip.getBoundingClientRect();

			let left = rect.left + rect.width / 2;
			if (left + tipRect.width / 2 > window.innerWidth) left = window.innerWidth - tipRect.width / 2 - 10;
			if (left - tipRect.width / 2 < 0) left = tipRect.width / 2 + 10;

			let top = rect.top - tipRect.height - topOffset;
			if (top < 10) top = rect.bottom + 10;

			tooltip.style.left = `${left}px`;
			tooltip.style.top = `${top}px`;
			tooltip.style.transform = 'translateX(-50%)';
		};

		const hide = () => {
			tooltip.style.opacity = '0';
			clearTimeout(hideTimer);
		};

		element.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'touch' || e.pointerType === 'pen') {
				pressTimer = setTimeout(() => {
					show();
					hideTimer = setTimeout(hide, 3000);
				}, 500);
			}
		});

		element.addEventListener('pointerup', () => clearTimeout(pressTimer));
		element.addEventListener('pointercancel', () => {
			clearTimeout(pressTimer);
			hide();
		});

		element.addEventListener('pointerenter', (e) => {
			if (e.pointerType === 'mouse') show();
		});

		element.addEventListener('pointerleave', (e) => {
			if (e.pointerType === 'mouse') hide();
		});
	}

	function makeTooltip(text) {
		const tip = document.createElement('div');
		tip.className = 'bg-bg-500 text-text-000 cc-tooltip';
		tip.textContent = text;
		document.body.appendChild(tip);
		return tip;
	}

	class CounterUI {
		constructor({ onUsageRefresh } = {}) {
			this.onUsageRefresh = onUsageRefresh || null;

			this.headerContainer = null;
			this.headerDisplay = null;
			this.lengthGroup = null;
			this.lengthDisplay = null;
			this.cachedDisplay = null;
			this.lengthBar = null;
			this.lengthTooltip = null;
			this.lastCachedUntilMs = null;
			this.pendingCache = false;

			this.usageLine = null;
			this.sessionUsageSpan = null;
			this.weeklyUsageSpan = null;
			this.sessionBar = null;
			this.sessionBarFill = null;
			this.weeklyBar = null;
			this.weeklyBarFill = null;
			this.sessionResetMs = null;
			this.weeklyResetMs = null;
			this.sessionMarker = null;
			this.weeklyMarker = null;
			this.sessionWindowStartMs = null;
			this.weeklyWindowStartMs = null;
			this.refreshingUsage = false;

			this.domObserver = null;
			this.sessionTooltip = null;
			this.weeklyTooltip = null;
			this.lastUsage = null;
			try {
				const val = localStorage.getItem('cc-show-local-time');
				this.showLocalTime = val !== null ? val === 'true' : true;
			} catch {
				this.showLocalTime = true;
			}
		}

		getProgressChrome() {
			const root = document.documentElement;
			const modeDark = root.dataset?.mode === 'dark';
			const modeLight = root.dataset?.mode === 'light';
			const isDark = modeDark && !modeLight;

			return {
				strokeColor: isDark ? CC.COLORS.PROGRESS_OUTLINE_DARK : CC.COLORS.PROGRESS_OUTLINE_LIGHT,
				fillColor: isDark ? CC.COLORS.PROGRESS_FILL_DARK : CC.COLORS.PROGRESS_FILL_LIGHT,
				markerColor: isDark ? CC.COLORS.PROGRESS_MARKER_DARK : CC.COLORS.PROGRESS_MARKER_LIGHT,
				boldColor: isDark ? CC.COLORS.BOLD_DARK : CC.COLORS.BOLD_LIGHT
			};
		}

		refreshProgressChrome() {
			const { strokeColor, fillColor, markerColor } = this.getProgressChrome();

			const applyBarChrome = (bar, { fillWarn } = {}) => {
				if (!bar) return;
				bar.style.setProperty('--cc-stroke', strokeColor);
				bar.style.setProperty('--cc-fill', fillColor);
				bar.style.setProperty('--cc-fill-warn', fillWarn ?? fillColor);
				bar.style.setProperty('--cc-marker', markerColor);
			};

			applyBarChrome(this.lengthBar, { fillWarn: fillColor });
			applyBarChrome(this.sessionBar, { fillWarn: CC.COLORS.RED_WARNING });
			applyBarChrome(this.weeklyBar, { fillWarn: CC.COLORS.RED_WARNING });
		}

		initialize() {
			// Header container (tokens + cache timer)
			this.headerContainer = document.createElement('div');
			this.headerContainer.className = 'text-text-500 text-xs !px-1 cc-header';

			this.headerDisplay = document.createElement('span');
			this.headerDisplay.className = 'cc-headerItem';

			this.lengthGroup = document.createElement('span');
			this.lengthDisplay = document.createElement('span');
			this.cachedDisplay = document.createElement('span');
			this.cacheTimeSpan = null; // reference to inner time span

			this.lengthGroup.appendChild(this.lengthDisplay);
			this.headerDisplay.appendChild(this.lengthGroup);

			// Usage line (session + weekly)
			this._initUsageLine();

			this._setupTooltips();
			this._observeDom();
			this._observeTheme();
		}

		_observeTheme() {
			// Watch for theme changes (data-mode attribute on <html>)
			const observer = new MutationObserver(() => this.refreshProgressChrome());
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
		}

		_observeDom() {
			// Track pending reattach attempts independently
			let usageReattachPending = false;
			let headerReattachPending = false;

			this.domObserver = new MutationObserver(() => {
				const usageMissing = this.usageLine && !document.contains(this.usageLine);
				const headerMissing = !document.contains(this.headerContainer);

				if (usageMissing && !usageReattachPending) {
					usageReattachPending = true;
					CC.waitForAnyElement([
						CC.DOM.MODEL_SELECTOR_DROPDOWN,
						'[data-testid="chat-input-grid-container"]',
						'[data-testid="chat-input-grid-area"]',
						'textarea'
					], 60000).then((el) => {
						usageReattachPending = false;
						if (el) this.attachUsageLine();
					});
				}

				if (headerMissing && !headerReattachPending) {
					headerReattachPending = true;
					CC.waitForAnyElement([
						CC.DOM.CHAT_MENU_TRIGGER,
						'header',
						'[role="banner"]'
					], 60000).then((el) => {
						headerReattachPending = false;
						if (el) this.attachHeader();
					});
				}
			});
			this.domObserver.observe(document.body, { childList: true, subtree: true });
		}

		_initUsageLine() {
			this.usageLine = document.createElement('div');
			this.usageLine.className =
				'text-text-400 text-[11px] cc-usageRow cc-hidden flex flex-row items-center gap-3 w-full';

			this.sessionUsageSpan = document.createElement('span');
			this.sessionUsageSpan.className = 'cc-usageText';

			this.sessionBar = document.createElement('div');
			this.sessionBar.className = 'cc-bar cc-bar--usage';
			this.sessionBarFill = document.createElement('div');
			this.sessionBarFill.className = 'cc-bar__fill';
			this.sessionMarker = document.createElement('div');
			this.sessionMarker.className = 'cc-bar__marker cc-hidden';
			this.sessionMarker.style.left = '0%';
			this.sessionBar.appendChild(this.sessionBarFill);
			this.sessionBar.appendChild(this.sessionMarker);

			this.weeklyUsageSpan = document.createElement('span');
			this.weeklyUsageSpan.className = 'cc-usageText';

			this.weeklyBar = document.createElement('div');
			this.weeklyBar.className = 'cc-bar cc-bar--usage';
			this.weeklyBarFill = document.createElement('div');
			this.weeklyBarFill.className = 'cc-bar__fill';
			this.weeklyMarker = document.createElement('div');
			this.weeklyMarker.className = 'cc-bar__marker cc-hidden';
			this.weeklyMarker.style.left = '0%';
			this.weeklyBar.appendChild(this.weeklyBarFill);
			this.weeklyBar.appendChild(this.weeklyMarker);

			this.sessionGroup = document.createElement('div');
			this.sessionGroup.className = 'cc-usageGroup';
			this.sessionGroup.appendChild(this.sessionUsageSpan);
			this.sessionGroup.appendChild(this.sessionBar);

			this.weeklyGroup = document.createElement('div');
			this.weeklyGroup.className = 'cc-usageGroup cc-usageGroup--weekly';
			this.weeklyGroup.appendChild(this.weeklyBar);
			this.weeklyGroup.appendChild(this.weeklyUsageSpan);

			this.usageLine.appendChild(this.sessionGroup);
			this.usageLine.appendChild(this.weeklyGroup);

			this.refreshProgressChrome();

			const handleTimeClick = (e) => {
				e.stopPropagation();
				this.showLocalTime = !this.showLocalTime;
				try {
					localStorage.setItem('cc-show-local-time', this.showLocalTime);
				} catch {}
				if (this.lastUsage) {
					this.setUsage(this.lastUsage);
				}
			};
			this.sessionUsageSpan.addEventListener('click', handleTimeClick);
			this.weeklyUsageSpan.addEventListener('click', handleTimeClick);

			this.usageLine.addEventListener('click', async () => {
				if (!this.onUsageRefresh || this.refreshingUsage) return;
				this.refreshingUsage = true;
				this.usageLine.classList.add('cc-usageRow--dim');
				try {
					await this.onUsageRefresh();
				} finally {
					this.usageLine.classList.remove('cc-usageRow--dim');
					this.refreshingUsage = false;
				}
			});
		}

		_setupTooltips() {
			this.lengthTooltip = makeTooltip(
				"Approximate tokens (excludes system prompt).\nUses a generic tokenizer, may differ from Claude's count.\nBecomes invalid after context compaction.\nBar scale: 200k tokens (Claude's maximum context length, will compact before then)."
			);
			setupTooltip(
				this.lengthGroup,
				this.lengthTooltip,
				{ topOffset: 8 }
			);

			setupTooltip(
				this.cachedDisplay,
				makeTooltip("Messages sent while cached are significantly cheaper."),
				{ topOffset: 8 }
			);

			this.sessionTooltip = makeTooltip("5-hour session window.\nThe bar shows your usage.\nThe line marks where you are in the window.");
			setupTooltip(
				this.sessionGroup,
				this.sessionTooltip,
				{ topOffset: 8 }
			);

			this.weeklyTooltip = makeTooltip("7-day usage window.\nThe bar shows your usage.\nThe line marks where you are in the window.");
			setupTooltip(
				this.weeklyGroup,
				this.weeklyTooltip,
				{ topOffset: 8 }
			);
		}

		attach() {
			this.attachHeader();
			this.attachUsageLine();
			this.refreshProgressChrome();
		}

		attachHeader() {
			let anchor = null;
			const chatMenu = document.querySelector(CC.DOM.CHAT_MENU_TRIGGER);
			if (chatMenu) {
				anchor = chatMenu.closest(CC.DOM.CHAT_PROJECT_WRAPPER) || chatMenu.parentElement;
			}

			// Fallback: If chatMenu doesn't exist, we can look for other header or title wrapper elements
			if (!anchor) {
				const header = document.querySelector('header') || 
				               document.querySelector('[role="banner"]') || 
				               document.querySelector('.flex.items-center.justify-between');
				if (header) {
					anchor = header;
				}
			}

			if (!anchor) return;
			if (anchor.nextElementSibling !== this.headerContainer) {
				anchor.after(this.headerContainer);
			}
			this._renderHeader();
			this.refreshProgressChrome();
		}

		attachUsageLine() {
			if (!this.usageLine) return;
			let anchor = null;

			// 1. Find the outer input card / container
			const inputContainer =
				document.querySelector(CC.DOM.CHAT_INPUT_CONTAINER) ||
				document.querySelector(CC.DOM.CHAT_INPUT_AREA) ||
				document.querySelector('form:has(textarea)') ||
				document.querySelector('textarea')?.closest('form') ||
				document.querySelector('textarea')?.closest('fieldset') ||
				document.querySelector('textarea')?.closest('.relative');

			if (inputContainer) {
				anchor = inputContainer;
			} else {
				// Fallback via model selector's top card container
				const modelSelector = document.querySelector(CC.DOM.MODEL_SELECTOR_DROPDOWN);
				if (modelSelector) {
					anchor =
						modelSelector.closest('[data-testid="chat-input-grid-container"]') ||
						modelSelector.closest('form') ||
						modelSelector.closest('fieldset') ||
						modelSelector.parentElement?.parentElement?.parentElement;
				}
			}

			if (!anchor) return;
			if (anchor.nextElementSibling !== this.usageLine) {
				anchor.after(this.usageLine);
			}
			this.refreshProgressChrome();
		}

		setPendingCache(pending) {
			this.pendingCache = pending;
			if (this.cacheTimeSpan) {
				if (pending) {
					this.cacheTimeSpan.style.color = '';
				} else {
					const { boldColor } = this.getProgressChrome();
					this.cacheTimeSpan.style.color = boldColor;
				}
			}
		}

		setConversationMetrics({ totalTokens, cachedUntil } = {}) {
			this.pendingCache = false;

			if (typeof totalTokens !== 'number') {
				this.lengthDisplay.textContent = '';
				this.cachedDisplay.textContent = '';
				this.lastCachedUntilMs = null;
				this._renderHeader();
				return;
			}

			const pct = Math.max(0, Math.min(100, (totalTokens / CC.CONST.CONTEXT_LIMIT_TOKENS) * 100));
			this.lengthDisplay.textContent = `~${totalTokens.toLocaleString()} tokens`;

			// Mini bar (hide when full - context is definitely compacted by then)
			const isFull = pct >= 99.5;
			if (isFull) {
				this.lengthDisplay.style.opacity = '0.5';
				this.lengthBar = null;
				this.lengthGroup.replaceChildren(this.lengthDisplay);
				if (this.lengthTooltip) {
					this.lengthTooltip.textContent =
						"Approximate tokens (excludes system prompt).\nUses a generic tokenizer, may differ from Claude's count.\nThis count is invalid after compaction.";
				}
			} else {
				this.lengthDisplay.style.opacity = '';
				const bar = document.createElement('div');
				bar.className = 'cc-bar cc-bar--mini';
				this.lengthBar = bar;
				const fill = document.createElement('div');
				fill.className = 'cc-bar__fill';
				fill.style.width = `${pct}%`;
				bar.appendChild(fill);
				this.refreshProgressChrome();

				const barContainer = document.createElement('span');
				barContainer.className = 'inline-flex items-center';
				barContainer.appendChild(bar);

				this.lengthGroup.replaceChildren(this.lengthDisplay, document.createTextNode('\u00A0\u00A0'), barContainer);
			}

			// Cache timer
			const now = Date.now();
			if (typeof cachedUntil === 'number' && cachedUntil > now) {
				this.lastCachedUntilMs = cachedUntil;
				const secondsLeft = Math.max(0, Math.ceil((cachedUntil - now) / 1000));
				const { boldColor } = this.getProgressChrome();
				this.cacheTimeSpan = Object.assign(document.createElement('span'), {
					className: 'cc-cacheTime',
					textContent: formatSeconds(secondsLeft)
				});
				this.cacheTimeSpan.style.color = boldColor;
				this.cachedDisplay.replaceChildren(document.createTextNode('cached for\u00A0'), this.cacheTimeSpan);
			} else {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.cachedDisplay.textContent = '';
			}

			this._renderHeader();
		}

		_renderHeader() {
			this.headerContainer.replaceChildren();

			const hasTokens = !!this.lengthDisplay.textContent;
			const hasCache = !!this.cachedDisplay.textContent;

			if (!hasTokens) return;

			if (hasCache) {
				const gap = this.lengthBar ? '\u00A0\u00A0' : '\u00A0';
				this.headerDisplay.replaceChildren(
					this.lengthGroup,
					document.createTextNode(gap),
					this.cachedDisplay
				);
			} else {
				this.headerDisplay.replaceChildren(this.lengthGroup);
			}

			this.headerContainer.appendChild(this.headerDisplay);
		}

		setUsage(usage) {
			this.lastUsage = usage;
			this.refreshProgressChrome();
			const session = usage?.five_hour || null;
			const weekly = usage?.seven_day || null;
			const hasAnyUsage =
				!!(session && typeof session.utilization === 'number') || !!(weekly && typeof weekly.utilization === 'number');
			this.usageLine?.classList.toggle('cc-hidden', !hasAnyUsage);

			if (session && typeof session.utilization === 'number') {
				const rawPct = session.utilization;
				const pct = Math.round(rawPct * 10) / 10;
				this.sessionResetMs = session.resets_at ? Date.parse(session.resets_at) : null;
				this.sessionWindowStartMs = this.sessionResetMs ? this.sessionResetMs - 5 * 60 * 60 * 1000 : null;
				
				let resetText = '';
				if (this.sessionResetMs) {
					if (this.showLocalTime) {
						const localTime = formatLocalTime(this.sessionResetMs);
						resetText = localTime ? ` · resets ${localTime}` : '';
					} else {
						resetText = ` · resets in ${formatResetCountdown(this.sessionResetMs)}`;
					}
				}
				this.sessionUsageSpan.textContent = `Session: ${pct}%${resetText}`;

				const width = Math.max(0, Math.min(100, rawPct));
				this.sessionBarFill.style.width = `${width}%`;
				this.sessionBarFill.classList.toggle('cc-warn', width >= 90);
				this.sessionBarFill.classList.toggle('cc-full', width >= 99.5);
			} else {
				this.sessionUsageSpan.textContent = '';
				this.sessionBarFill.style.width = '0%';
				this.sessionBarFill.classList.remove('cc-warn', 'cc-full');
				this.sessionResetMs = null;
				this.sessionWindowStartMs = null;
			}

			const hasWeekly = weekly && typeof weekly.utilization === 'number';
			this.weeklyGroup?.classList.toggle('cc-hidden', !hasWeekly);
			this.sessionGroup?.classList.toggle('cc-usageGroup--single', !hasWeekly);

			if (hasWeekly) {
				this.weeklyUsageSpan.classList.remove('cc-hidden');
				this.weeklyBar.classList.remove('cc-hidden');

				const rawPct = weekly.utilization;
				const pct = Math.round(rawPct * 10) / 10;
				this.weeklyResetMs = weekly.resets_at ? Date.parse(weekly.resets_at) : null;
				this.weeklyWindowStartMs = this.weeklyResetMs ? this.weeklyResetMs - 7 * 24 * 60 * 60 * 1000 : null;

				let resetText = '';
				if (this.weeklyResetMs) {
					if (this.showLocalTime) {
						const localTime = formatLocalTime(this.weeklyResetMs);
						resetText = localTime ? ` · resets ${localTime}` : '';
					} else {
						resetText = ` · resets in ${formatResetCountdown(this.weeklyResetMs)}`;
					}
				}
				this.weeklyUsageSpan.textContent = `Weekly: ${pct}%${resetText}`;

				const width = Math.max(0, Math.min(100, rawPct));
				this.weeklyBarFill.style.width = `${width}%`;
				this.weeklyBarFill.classList.toggle('cc-warn', width >= 90);
				this.weeklyBarFill.classList.toggle('cc-full', width >= 99.5);
			} else {
				this.weeklyUsageSpan.classList.add('cc-hidden');
				this.weeklyBar.classList.add('cc-hidden');
				this.weeklyResetMs = null;
				this.weeklyWindowStartMs = null;
				this.weeklyBarFill.classList.remove('cc-warn', 'cc-full');
			}

			this._updateMarkers();
			this._updateTooltips();
		}

		_updateMarkers() {
			const now = Date.now();

			if (this.sessionMarker && this.sessionWindowStartMs && this.sessionResetMs) {
				const total = this.sessionResetMs - this.sessionWindowStartMs;
				const elapsed = Math.max(0, Math.min(total, now - this.sessionWindowStartMs));
				const ratio = total > 0 ? elapsed / total : 0;
				const pct = Math.max(0, Math.min(100, ratio * 100));
				this.sessionMarker.classList.remove('cc-hidden');
				this.sessionMarker.style.left = `${pct}%`;
			} else if (this.sessionMarker) {
				this.sessionMarker.classList.add('cc-hidden');
			}

			if (this.weeklyMarker && this.weeklyWindowStartMs && this.weeklyResetMs) {
				const total = this.weeklyResetMs - this.weeklyWindowStartMs;
				const elapsed = Math.max(0, Math.min(total, now - this.weeklyWindowStartMs));
				const ratio = total > 0 ? elapsed / total : 0;
				const pct = Math.max(0, Math.min(100, ratio * 100));
				this.weeklyMarker.classList.remove('cc-hidden');
				this.weeklyMarker.style.left = `${pct}%`;
			} else if (this.weeklyMarker) {
				this.weeklyMarker.classList.add('cc-hidden');
			}
		}

		_updateTooltips() {
			if (this.sessionTooltip) {
				const base = "5-hour session window.\nThe bar shows your usage.\nThe line marks where you are in the window.";
				const fullTime = this.sessionResetMs ? getFullLocalResetString(this.sessionResetMs) : '';
				this.sessionTooltip.textContent = fullTime ? `${base}\n\nNext session starts:\n${fullTime}` : base;
			}
			if (this.weeklyTooltip) {
				const base = "7-day usage window.\nThe bar shows your usage.\nThe line marks where you are in the window.";
				const fullTime = this.weeklyResetMs ? getFullLocalResetString(this.weeklyResetMs) : '';
				this.weeklyTooltip.textContent = fullTime ? `${base}\n\nNext session starts:\n${fullTime}` : base;
			}
		}

		tick() {
			// Cache countdown
			const now = Date.now();
			if (this.lastCachedUntilMs && this.lastCachedUntilMs > now) {
				const secondsLeft = Math.max(0, Math.ceil((this.lastCachedUntilMs - now) / 1000));
				if (this.cacheTimeSpan) {
					this.cacheTimeSpan.textContent = formatSeconds(secondsLeft);
				}
			} else if (this.lastCachedUntilMs && this.lastCachedUntilMs <= now) {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.pendingCache = false;
				this.cachedDisplay.textContent = '';
				this._renderHeader();
			}

			// Reset countdown text + time markers
			if (this.sessionResetMs && this.sessionUsageSpan?.textContent) {
				const idx = this.sessionUsageSpan.textContent.indexOf('· resets');
				if (idx !== -1) {
					const prefix = this.sessionUsageSpan.textContent.slice(0, idx + '· resets'.length);
					let suffix = '';
					if (this.showLocalTime) {
						const localTime = formatLocalTime(this.sessionResetMs);
						suffix = localTime ? ` ${localTime}` : '';
					} else {
						suffix = ` in ${formatResetCountdown(this.sessionResetMs)}`;
					}
					this.sessionUsageSpan.textContent = `${prefix}${suffix}`;
				}
			}

			if (this.weeklyResetMs && this.weeklyUsageSpan?.textContent) {
				const idx = this.weeklyUsageSpan.textContent.indexOf('· resets');
				if (idx !== -1) {
					const prefix = this.weeklyUsageSpan.textContent.slice(0, idx + '· resets'.length);
					let suffix = '';
					if (this.showLocalTime) {
						const localTime = formatLocalTime(this.weeklyResetMs);
						suffix = localTime ? ` ${localTime}` : '';
					} else {
						suffix = ` in ${formatResetCountdown(this.weeklyResetMs)}`;
					}
					this.weeklyUsageSpan.textContent = `${prefix}${suffix}`;
				}
			}

			this._updateMarkers();
			this._updateTooltips();
		}
	}

	CC.ui = {
		CounterUI
	};
})();


(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__ccUserscriptStarted) return;
	CC.__ccUserscriptStarted = true;

	const STYLE_ID = 'cc-userscript-styles';
	const STYLES = '/* Header: tokens + cache timer */\n.cc-header {\n\tdisplay: inline-flex;\n\talign-items: center;\n\tmargin: 6px 12px;\n\tpadding: 4px 8px;\n\tbackground: rgba(128, 128, 128, 0.05);\n\tborder: 1px solid rgba(128, 128, 128, 0.1);\n\tborder-radius: 6px;\n\tfont-size: 11px;\n\tuser-select: none;\n}\n\n.cc-headerItem {\n\twhite-space: nowrap;\n}\n\n/* Usage row: session + weekly */\n.cc-usageRow {\n\tbox-sizing: border-box;\n\twidth: 100%;\n\tmax-width: 100%;\n\tdisplay: flex;\n\tflex-direction: row;\n\talign-items: center;\n\tjustify-content: space-between;\n\tflex-wrap: wrap;\n\tgap: 8px 16px;\n\tmargin-top: 8px;\n\tmargin-bottom: 4px;\n\tpadding: 4px 6px;\n\tposition: relative;\n\tz-index: 10;\n\tcursor: pointer;\n\tuser-select: none;\n\ttransition: opacity 150ms ease;\n\tclear: both;\n}\n\n.cc-usageRow--dim {\n\topacity: 0.6;\n}\n\n/* Row group layout */\n.cc-usageGroup {\n\tdisplay: flex;\n\talign-items: center;\n\tgap: 8px;\n\tflex: 1 1 180px;\n\tmin-width: 0;\n}\n\n.cc-usageGroup--single {\n\twidth: 100%;\n}\n\n.cc-usageGroup--weekly {\n\tjustify-content: flex-end;\n}\n\n.cc-usageText {\n\twhite-space: nowrap;\n\tcursor: pointer;\n}\n\n.cc-usageText:hover {\n\ttext-decoration: underline;\n}\n\n/* Bars (mini + usage) */\n.cc-bar {\n\t--cc-radius: 3px;\n\t--cc-stroke: transparent;\n\t--cc-fill: transparent;\n\t--cc-fill-warn: var(--cc-fill);\n\t--cc-marker: transparent;\n\n\tposition: relative;\n\tbox-sizing: border-box;\n\twidth: 100%;\n\theight: 6px;\n\tborder-radius: var(--cc-radius);\n\tborder: 1px solid var(--cc-stroke);\n\toverflow: visible;\n\tuser-select: none;\n}\n\n.cc-bar__fill {\n\twidth: 0%;\n\theight: 100%;\n\tbackground: var(--cc-fill);\n\ttransition: width 300ms ease, background-color 300ms ease;\n\tborder-top-left-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-bottom-left-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-top-right-radius: 0;\n\tborder-bottom-right-radius: 0;\n}\n\n.cc-bar__fill.cc-full {\n\tborder-top-right-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-bottom-right-radius: max(0px, calc(var(--cc-radius) - 1px));\n}\n\n.cc-bar__fill.cc-warn {\n\tbackground: var(--cc-fill-warn);\n}\n\n.cc-bar__marker {\n\tposition: absolute;\n\ttop: 0;\n\tbottom: 0;\n\tleft: 0%;\n\twidth: 2px;\n\tbackground: var(--cc-marker);\n\tpointer-events: none;\n}\n\n.cc-bar--mini {\n\twidth: 60px;\n\theight: 7px;\n\t--cc-radius: 2px;\n}\n\n.cc-bar--usage {\n\theight: 8px;\n\tflex: 1;\n\tmin-width: 50px;\n}\n\n/* Tooltips */\n.cc-tooltip {\n\tposition: fixed;\n\tz-index: 9999;\n\tpadding: 4px 8px;\n\tborder-radius: 4px;\n\tfont-size: 12px;\n\twhite-space: pre-line;\n\tuser-select: none;\n\tpointer-events: none;\n\topacity: 0;\n\ttransition: opacity 200ms ease;\n}\n\n.cc-tooltipTrigger {\n\t-webkit-touch-callout: none;\n\t-webkit-user-select: none;\n\tuser-select: none;\n\tcursor: help;\n}\n\n/* Hide optional elements completely (no layout space) */\n.cc-hidden {\n\tdisplay: none !important;\n}\n';

	function injectStyles() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = STYLES;
		(document.head || document.documentElement).appendChild(style);
	}

	function getConversationId() {
		const match = window.location.pathname.match(/\/(chat|code)\/([^/?]+)/);
		return match ? match[2] : null;
	}

	function getOrgIdFromCookie() {
		try {
			return document.cookie
				.split('; ')
				.find((row) => row.startsWith('lastActiveOrg='))
				?.split('=')[1] || null;
		} catch {
			return null;
		}
	}

	function waitForElement(selector, timeoutMs) {
		return new Promise((resolve) => {
			const existing = document.querySelector(selector);
			if (existing) {
				resolve(existing);
				return;
			}

			let timeoutId;
			const observer = new MutationObserver(() => {
				const el = document.querySelector(selector);
				if (el) {
					if (timeoutId) clearTimeout(timeoutId);
					observer.disconnect();
					resolve(el);
				}
			});

			observer.observe(document.body, { childList: true, subtree: true });

			if (timeoutMs) {
				timeoutId = setTimeout(() => {
					observer.disconnect();
					resolve(null);
				}, timeoutMs);
			}
		});
	}

	function waitForAnyElement(selectors, timeoutMs) {
		return new Promise((resolve) => {
			for (const selector of selectors) {
				const existing = document.querySelector(selector);
				if (existing) {
					resolve(existing);
					return;
				}
			}

			let timeoutId;
			const observer = new MutationObserver(() => {
				for (const selector of selectors) {
					const el = document.querySelector(selector);
					if (el) {
						if (timeoutId) clearTimeout(timeoutId);
						observer.disconnect();
						resolve(el);
						return;
					}
				}
			});

			observer.observe(document.body, { childList: true, subtree: true });

			if (timeoutMs) {
				timeoutId = setTimeout(() => {
					observer.disconnect();
					resolve(null);
				}, timeoutMs);
			}
		});
	}

	CC.waitForElement = waitForElement;
	CC.waitForAnyElement = waitForAnyElement;

	function parseUsageFromUsageEndpoint(raw) {
		if (!raw || typeof raw !== 'object') return null;

		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization));
			const resets_at = typeof w.resets_at === 'string' ? w.resets_at : null;
			return { utilization, resets_at, window_hours: hours };
		};

		const fiveHour = normalizeWindow(raw.five_hour, 5);
		const sevenDay = normalizeWindow(raw.seven_day, 24 * 7);

		if (!fiveHour && !sevenDay) return null;
		return { five_hour: fiveHour, seven_day: sevenDay };
	}

	function parseUsageFromMessageLimit(raw) {
		if (!raw?.windows || typeof raw.windows !== 'object') return null;

		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization * 100));
			const resets_at = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at)
				? new Date(w.resets_at * 1000).toISOString()
				: null;
			return { utilization, resets_at, window_hours: hours };
		};

		const fiveHour = normalizeWindow(raw.windows['5h'], 5);
		const sevenDay = normalizeWindow(raw.windows['7d'], 24 * 7);

		if (!fiveHour && !sevenDay) return null;
		return { five_hour: fiveHour, seven_day: sevenDay };
	}

	let currentConversationId = null;
	let currentOrgId = null;

	let usageState = null;
	let usageResetMs = { five_hour: null, seven_day: null };
	let activeResetTimerMs = null; // Next future session reset timestamp
	let lastUsageSseMs = 0;
	let usageFetchInFlight = false;
	let lastUsageUpdateMs = 0;
	const rolloverHandledForResetMs = { five_hour: null, seven_day: null };

	const ui = new CC.ui.CounterUI({
		onUsageRefresh: async () => {
			await refreshUsage();
		}
	});

	const originalFetch = CC._ccInternal?.originalFetch || (window.fetch ? window.fetch.bind(window) : null);

	function playTidingSound() {
		try {
			const AudioContext = window.AudioContext || window.webkitAudioContext;
			if (!AudioContext) return;
			const audioCtx = new AudioContext();

			const playNote = (frequency, startTime, duration) => {
				const osc = audioCtx.createOscillator();
				const gainNode = audioCtx.createGain();

				osc.type = 'sine';
				osc.frequency.setValueAtTime(frequency, startTime);

				gainNode.gain.setValueAtTime(0, startTime);
				// Fast attack
				gainNode.gain.linearRampToValueAtTime(0.15, startTime + 0.05);
				// Exponential decay
				gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

				osc.connect(gainNode);
				gainNode.connect(audioCtx.destination);

				osc.start(startTime);
				osc.stop(startTime + duration);
			};

			const now = audioCtx.currentTime;
			// A beautiful "tiding" chime (C5 -> E5 -> G5 -> C6)
			playNote(523.25, now, 0.8);
			playNote(659.25, now + 0.1, 0.8);
			playNote(783.99, now + 0.2, 1.0);
			playNote(1046.50, now + 0.3, 1.2);
		} catch (e) {
			console.error('Failed to play tiding sound:', e);
		}
	}

	function sendNotification(title, body) {
		try {
			if ('Notification' in window) {
				if (Notification.permission === 'granted') {
					new Notification(title, { body });
				} else if (Notification.permission !== 'denied') {
					Notification.requestPermission().then((perm) => {
						if (perm === 'granted') {
							new Notification(title, { body });
						}
					});
				}
			}
		} catch (e) {
			console.error('Failed to send notification:', e);
		}
	}

	if ('Notification' in window && Notification.permission === 'default') {
		Notification.requestPermission().catch(() => {});
	}

	let lastFiveHourResetKey = null;

	function applyUsageUpdate(normalized, source) {
		if (!normalized) return;
		const now = Date.now();
		const prevFiveHourResetKey = lastFiveHourResetKey;
		usageState = normalized;
		lastUsageUpdateMs = now;
		if (source === 'sse') lastUsageSseMs = now;
		const fiveHourReset = normalized.five_hour?.resets_at ? Date.parse(normalized.five_hour.resets_at) : null;
		usageResetMs.five_hour = fiveHourReset;
		usageResetMs.seven_day = normalized.seven_day?.resets_at ? Date.parse(normalized.seven_day.resets_at) : null;

		if (fiveHourReset && fiveHourReset > now) {
			activeResetTimerMs = fiveHourReset;
		} else {
			activeResetTimerMs = null;
		}

		if (normalized.five_hour?.resets_at) {
			lastFiveHourResetKey = normalized.five_hour.resets_at;
			if (prevFiveHourResetKey && prevFiveHourResetKey !== normalized.five_hour.resets_at) {
				const resetStr = new Date(normalized.five_hour.resets_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
				sendNotification('Claude Session Started', `New 5-hour session is active (resets @ ${resetStr}).`);
			}
		}

		ui.setUsage(normalized);
	}

	function updateOrgIdIfNeeded(newOrgId) {
		if (newOrgId && typeof newOrgId === 'string' && newOrgId !== currentOrgId) {
			currentOrgId = newOrgId;
		}
	}

	async function requestUsage(orgId) {
		if (!originalFetch) return null;
		const res = await originalFetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
			method: 'GET',
			credentials: 'include'
		});
		return await res.json();
	}

	async function requestConversation(orgId, conversationId) {
		if (!originalFetch) return null;
		const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;
		const res = await originalFetch(url, {
			method: 'GET',
			credentials: 'include'
		});
		const json = await res.json();
		return json;
	}

	async function refreshUsage() {
		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		if (usageFetchInFlight) return;
		usageFetchInFlight = true;
		let raw;
		try {
			raw = await requestUsage(orgId);
		} catch {
			return;
		} finally {
			usageFetchInFlight = false;
		}

		const parsed = parseUsageFromUsageEndpoint(raw);
		applyUsageUpdate(parsed, 'usage');
	}

	async function refreshConversation() {
		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		try {
			const data = await requestConversation(orgId, currentConversationId);
			await handleConversationPayload({ orgId, conversationId: currentConversationId, data });
		} catch {
			// ignore
		}
	}

	function handleGenerationStart() {
		if (!currentConversationId) return;
		ui.setPendingCache(true);
	}

	async function handleConversationPayload({ orgId, conversationId, data }) {
		updateOrgIdIfNeeded(orgId);
		if (!data) return;

		// Dynamically update currentConversationId if we are on a chat/code page
		const path = window.location.pathname;
		if (path.startsWith('/chat') || path.startsWith('/code')) {
			currentConversationId = conversationId;
		}

		if (!conversationId || conversationId !== currentConversationId) return;

		const metrics = await CC.tokens.computeConversationMetrics(data);
		ui.setConversationMetrics({ totalTokens: metrics.totalTokens, cachedUntil: metrics.cachedUntil });
	}

	function handleMessageLimit(messageLimit) {
		const parsed = parseUsageFromMessageLimit(messageLimit);
		applyUsageUpdate(parsed, 'sse');
	}

	async function handleUrlChange() {
		currentConversationId = getConversationId();

		waitForAnyElement([
			CC.DOM.MODEL_SELECTOR_DROPDOWN,
			'[data-testid="chat-input-grid-container"]',
			'[data-testid="chat-input-grid-area"]',
			'textarea'
		], 60000).then((el) => {
			if (el) ui.attachUsageLine();
		});
		waitForAnyElement([
			CC.DOM.CHAT_MENU_TRIGGER,
			'header',
			'[role="banner"]'
		], 60000).then((el) => {
			if (el) ui.attachHeader();
		});

		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		updateOrgIdIfNeeded(getOrgIdFromCookie());

		await refreshConversation();

		if (!usageState) await refreshUsage();
	}

	function tick() {
		ui.tick();

		const now = Date.now();

		if (activeResetTimerMs && now >= activeResetTimerMs) {
			activeResetTimerMs = null;
			playTidingSound();
			sendNotification('Claude Session Reset', 'Your 5-hour Claude session has reset! Full capacity is restored.');
			refreshUsage();
		}

		if (usageResetMs.five_hour && now >= usageResetMs.five_hour && rolloverHandledForResetMs.five_hour !== usageResetMs.five_hour) {
			rolloverHandledForResetMs.five_hour = usageResetMs.five_hour;
			playTidingSound();
			sendNotification('Claude Session Reset', 'Your 5-hour Claude session has reset!');
			refreshUsage();
		}
		if (usageResetMs.seven_day && now >= usageResetMs.seven_day && rolloverHandledForResetMs.seven_day !== usageResetMs.seven_day) {
			rolloverHandledForResetMs.seven_day = usageResetMs.seven_day;
			sendNotification('Claude Weekly Limit Reset', 'Your weekly Claude usage limit has reset!');
			refreshUsage();
		}

		const ONE_HOUR_MS = 60 * 60 * 1000;
		const sseAge = now - lastUsageSseMs;
		const anyAge = now - lastUsageUpdateMs;
		if (!document.hidden && sseAge > ONE_HOUR_MS && anyAge > ONE_HOUR_MS) {
			refreshUsage();
		}
	}

	function start() {
		injectStyles();
		ui.initialize();
		CC._ccInternal.onGenerationStart = handleGenerationStart;
		CC._ccInternal.onConversationData = handleConversationPayload;
		CC._ccInternal.onMessageLimit = handleMessageLimit;
		CC._ccInternal.onUrlChange = handleUrlChange;

		handleUrlChange();
		setInterval(tick, 1000);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start, { once: true });
	} else {
		start();
	}
})();
