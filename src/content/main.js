(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__started) return;
	CC.__started = true;

	function getConversationId() {
		const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return match ? match[1] : null;
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

	/**
	 * Check if the current page is a chat page (where we should activate).
	 * We don't inject UI on /settings, /pricing, /login, etc.
	 */
	function isActivePage() {
		const path = window.location.pathname;
		return path === '/' || path.startsWith('/chat');
	}

	/**
	 * Wait for an element to appear in the DOM using MutationObserver.
	 * More efficient than polling - reacts immediately when element appears.
	 * @param {string} selector - CSS selector
	 * @param {number} [timeoutMs] - Optional timeout in ms. Returns null if timeout expires.
	 */
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

	CC.waitForElement = waitForElement;

	function observeUrlChanges(callback) {
		let lastPath = window.location.pathname;

		const fireIfChanged = () => {
			const current = window.location.pathname;
			if (current !== lastPath) {
				lastPath = current;
				callback();
			}
		};

		// Listen for custom event from bridge (history methods wrapped early)
		window.addEventListener('cc:urlchange', fireIfChanged);
		// Also popstate for back/forward buttons
		window.addEventListener('popstate', fireIfChanged);

		return () => {
			window.removeEventListener('cc:urlchange', fireIfChanged);
			window.removeEventListener('popstate', fireIfChanged);
		};
	}

	let currentConversationId = null;
	let currentOrgId = null;
	let currentContextLimit = CC.CONST.DEFAULT_CONTEXT_LIMIT;

	let usageState = null; // last snapshot
	let usageResetMs = { five_hour: null, seven_day: null }; // cached parsed timestamps
	let lastUsageSseMs = 0;
	let usageFetchInFlight = false;
	let lastUsageUpdateMs = 0;
	const MIN_USAGE_INTERVAL_MS = 30000; // S13: rate limit usage API calls
	const rolloverHandledForResetMs = { five_hour: null, seven_day: null };

	const ui = new CC.ui.CounterUI({
		onUsageRefresh: async () => {
			await refreshUsage();
		}
	});
	ui.initialize();

	// Bridge must be ready before we can make requests
	const bridgeReady = CC.injectBridgeOnce();

	function applyUsageUpdate(normalized, source) {
		if (!normalized) return;
		const now = Date.now();
		usageState = normalized;
		lastUsageUpdateMs = now;
		if (source === 'sse') lastUsageSseMs = now;
		// Cache parsed timestamps to avoid Date.parse() every tick
		usageResetMs.five_hour = normalized.five_hour?.resets_at ? Date.parse(normalized.five_hour.resets_at) : null;
		usageResetMs.seven_day = normalized.seven_day?.resets_at ? Date.parse(normalized.seven_day.resets_at) : null;
		ui.setUsage(normalized);
	}

	function updateOrgIdIfNeeded(newOrgId) {
		if (newOrgId && typeof newOrgId === 'string' && newOrgId !== currentOrgId) {
			currentOrgId = newOrgId;
		}
	}

	/**
	 * Detect and apply the active model's context limit.
	 */
	function updateModelContext() {
		if (!CC.DOMDiscovery) return;
		const model = CC.DOMDiscovery.detectModel();
		if (model.contextLimit !== currentContextLimit) {
			currentContextLimit = model.contextLimit;
			ui.setContextLimit(currentContextLimit);
			CC.status.model = model.name;
			CC.log('Model detected:', model.name, '→ context limit:', model.contextLimit.toLocaleString());
		}
	}

	async function refreshUsage() {
		await bridgeReady;
		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		// S13: rate limit usage API calls
		if (Date.now() - lastUsageUpdateMs < MIN_USAGE_INTERVAL_MS) return;
		if (usageFetchInFlight) return;
		usageFetchInFlight = true;
		let raw;
		try {
			raw = await CC.bridge.requestUsage(orgId);
		} catch {
			return;
		} finally {
			usageFetchInFlight = false;
		}

		// Use centralized normalizer
		const parsed = CC.normalize.usage(raw);
		applyUsageUpdate(parsed, 'usage');
	}

	async function refreshConversation() {
		await bridgeReady;
		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		try {
			await CC.bridge.requestConversation(orgId, currentConversationId);
		} catch {
			// ignore
		}
	}

	function handleGenerationStart() {
		if (!currentConversationId) return;
		ui.setPendingCache(true);
	}

	async function handleConversationPayload({ orgId, conversationId, data }) {
		if (!conversationId || conversationId !== currentConversationId) return;
		updateOrgIdIfNeeded(orgId);
		if (!data) return;

		const metrics = await CC.tokens.computeConversationMetrics(data);
		ui.setConversationMetrics({ totalTokens: metrics.totalTokens, cachedUntil: metrics.cachedUntil });
	}

	function handleMessageLimit(messageLimit) {
		// Use centralized normalizer
		const parsed = CC.normalize.messageLimit(messageLimit);
		applyUsageUpdate(parsed, 'sse');
	}

	CC.bridge.on('cc:generation_start', handleGenerationStart);
	CC.bridge.on('cc:conversation', handleConversationPayload);
	CC.bridge.on('cc:message_limit', handleMessageLimit);

	async function handleUrlChange() {
		currentConversationId = getConversationId();

		// Only inject UI on chat pages
		if (!isActivePage()) {
			ui.setConversationMetrics();
			return;
		}

		// Detect model and set context limit
		updateModelContext();

		// Try to attach UI immediately near the input area
		const usageAnchor = CC.DOMDiscovery?.findUsageAnchor();
		if (usageAnchor && usageAnchor.confidence !== 'low') {
			ui.attach(); // attaches usage then header above it
		} else {
			// Wait for model selector to appear, then attach everything
			waitForElement(CC.SELECTORS.modelSelector, 15000).then((el) => {
				if (el) updateModelContext();
				ui.attach(); // works with fallback if element not found
			});
		}

		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		// Best-effort orgId from cookie.
		updateOrgIdIfNeeded(getOrgIdFromCookie());

		await refreshConversation();

		// Usage is org-level, not conversation-level. Only fetch on first load or if stale.
		if (!usageState) await refreshUsage();
	}

	// Watch for model selector changes (user switches models)
	// Free tier: 200k for ALL models, so context limit won't change.
	// Paid tier (future): 500k for Sonnet/Opus — would need refresh.
	// Keep observer for logging + future paid tier detection.
	let modelObserver = null;
	function observeModelChanges() {
		const modelBtn = document.querySelector(CC.SELECTORS.modelSelector);
		if (!modelBtn) return;

		// Disconnect previous observer if any
		modelObserver?.disconnect();

		modelObserver = new MutationObserver(() => {
			const prevLimit = currentContextLimit;
			const prevModel = CC.status.model;
			updateModelContext();
			if (CC.status.model !== prevModel) {
				CC.log('Model switched:', prevModel, '→', CC.status.model);
			}
			// Only refresh if limit actually changed (future: paid tier detection)
			if (currentContextLimit !== prevLimit) {
				CC.log('Context limit changed:', prevLimit, '→', currentContextLimit);
				refreshConversation();
			}
		});

		// Watch both the button's attributes AND its parent (Claude may replace the button)
		modelObserver.observe(modelBtn, {
			attributes: true,
			attributeFilter: ['aria-label'],
		});

		// Also watch the parent for child changes (button replacement)
		if (modelBtn.parentElement) {
			modelObserver.observe(modelBtn.parentElement, {
				childList: true,
				subtree: true,
			});
		}
	}

	const unobserveUrl = observeUrlChanges(handleUrlChange);
	window.addEventListener('beforeunload', unobserveUrl);

	// Refresh on branch navigation - watch for the branch indicator to change
	let branchObserver = null;
	document.addEventListener('click', (e) => {
		if (!currentConversationId) return;
		const btn = e.target.closest('button[aria-label="Previous"], button[aria-label="Next"]');
		if (!btn) return;

		// Find the branch indicator span (matches "X / Y" pattern) near the clicked button
		const container = btn.closest('.inline-flex') || btn.parentElement;
		const spans = container?.querySelectorAll('span') || [];
		const indicator = Array.from(spans).find((s) => /^\d+\s*\/\s*\d+$/.test(s.textContent.trim()));
		if (!indicator) return;

		const originalText = indicator.textContent;

		// Clean up any existing observer
		if (branchObserver) branchObserver.disconnect();

		// Watch for the indicator text to change (with cleanup timeout)
		branchObserver = new MutationObserver(() => {
			if (indicator.textContent !== originalText) {
				branchObserver.disconnect();
				branchObserver = null;
				refreshConversation();
			}
		});

		branchObserver.observe(indicator, { childList: true, characterData: true, subtree: true });

		// Clean up if nothing changes after 60 seconds
		setTimeout(() => {
			if (branchObserver) {
				branchObserver.disconnect();
				branchObserver = null;
			}
		}, 60000);
	});

	// Initial attach + fetches
	handleUrlChange();

	// Watch for model changes after initial load
	waitForElement(CC.SELECTORS.modelSelector, 15000).then(() => {
		observeModelChanges();
	});

	// --- Tick loop (with visibility-aware pause) ---
	function tick() {
		ui.tick();

		// Refresh usage when a window ends (5h / 7d). SSE won't fire at rollover unless a message is sent.
		const now = Date.now();

		if (usageResetMs.five_hour && now >= usageResetMs.five_hour && rolloverHandledForResetMs.five_hour !== usageResetMs.five_hour) {
			rolloverHandledForResetMs.five_hour = usageResetMs.five_hour;
			refreshUsage();
		}
		if (usageResetMs.seven_day && now >= usageResetMs.seven_day && rolloverHandledForResetMs.seven_day !== usageResetMs.seven_day) {
			rolloverHandledForResetMs.seven_day = usageResetMs.seven_day;
			refreshUsage();
		}

		// Optional hourly safety refresh.
		const ONE_HOUR_MS = 60 * 60 * 1000;
		const sseAge = now - lastUsageSseMs;
		const anyAge = now - lastUsageUpdateMs;
		if (!document.hidden && sseAge > ONE_HOUR_MS && anyAge > ONE_HOUR_MS) {
			refreshUsage();
		}
	}

	// P2: Visibility-aware tick — pause when tab is hidden to save CPU
	let tickInterval = setInterval(tick, 1000);

	document.addEventListener('visibilitychange', () => {
		if (document.hidden) {
			clearInterval(tickInterval);
			tickInterval = null;
		} else {
			if (!tickInterval) tickInterval = setInterval(tick, 1000);
			tick(); // Immediate tick on visibility restore
			// Re-detect model (user may have switched in another tab flow)
			updateModelContext();
		}
	});

	CC.log('Claude Counter', CC.VERSION, 'initialized');
	CC.status.bridgeOk = true;
})();
