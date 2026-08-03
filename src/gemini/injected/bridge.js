(() => {
	'use strict';

	const GC_MARKER = 'GeminiCounter';

	// Gemini's generate RPC. Matched strictly: batchexecute also carries title
	// generation, history sync and other chatter, so a loose match would count
	// prompts the user never sent. If Google renames this, the content script's
	// DOM fallback still catches the send.
	const GENERATE_PATTERNS = [
		/BardFrontendService\/StreamGenerate/i,
		/\/StreamGenerate(\?|$)/i
	];

	function isGenerateRequest(url, method) {
		if (!url || String(method || 'GET').toUpperCase() !== 'POST') return false;
		return GENERATE_PATTERNS.some((re) => re.test(url));
	}

	function post(type, payload) {
		try {
			window.postMessage({ gc: GC_MARKER, type, payload }, '*');
		} catch {
			// ignore
		}
	}

	function toAbsoluteUrl(input) {
		try {
			if (typeof input === 'string') return new URL(input, location.href).href;
			if (input instanceof URL) return input.href;
			if (input instanceof Request) return input.url;
		} catch {
			// ignore
		}
		return '';
	}

	// --- SPA navigation -------------------------------------------------------
	// Wrapped early, before Angular caches the originals.
	const originalPushState = history.pushState.bind(history);
	const originalReplaceState = history.replaceState.bind(history);

	history.pushState = function (...args) {
		const result = originalPushState(...args);
		window.dispatchEvent(new CustomEvent('gc:urlchange'));
		return result;
	};

	history.replaceState = function (...args) {
		const result = originalReplaceState(...args);
		window.dispatchEvent(new CustomEvent('gc:urlchange'));
		return result;
	};

	// --- fetch ----------------------------------------------------------------
	const originalFetch = window.fetch;

	if (typeof originalFetch === 'function') {
		window.fetch = function (...args) {
			try {
				const url = toAbsoluteUrl(args[0]);
				const method = args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET');
				if (isGenerateRequest(url, method)) {
					post('gc:prompt_sent', { url, at: Date.now(), source: 'fetch' });
				}
			} catch {
				// never break the host page
			}
			return originalFetch.apply(this, args);
		};
	}

	// --- XMLHttpRequest -------------------------------------------------------
	// Gemini has historically used XHR for chat RPCs, so a fetch-only wrapper
	// would miss sends entirely.
	const XHR = window.XMLHttpRequest;
	if (XHR?.prototype) {
		const originalOpen = XHR.prototype.open;
		const originalSend = XHR.prototype.send;

		XHR.prototype.open = function (method, url, ...rest) {
			try {
				this.__gcMethod = method;
				this.__gcUrl = toAbsoluteUrl(url);
			} catch {
				// ignore
			}
			return originalOpen.call(this, method, url, ...rest);
		};

		XHR.prototype.send = function (...args) {
			try {
				if (isGenerateRequest(this.__gcUrl, this.__gcMethod)) {
					post('gc:prompt_sent', { url: this.__gcUrl, at: Date.now(), source: 'xhr' });
				}
			} catch {
				// never break the host page
			}
			return originalSend.apply(this, args);
		};
	}

	post('gc:bridge_ready', {});
})();
