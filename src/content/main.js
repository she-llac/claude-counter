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

	function normalizeModelName(rawModel) {
		if (!rawModel || typeof rawModel !== 'string') return null;
		const lower = rawModel.toLowerCase();
		if (lower.includes('haiku')) return 'haiku';
		if (lower.includes('opus')) return 'opus';
		if (lower.includes('fable')) return 'fable';
		if (lower.includes('sonnet')) return 'sonnet';
		return null;
	}

	function parseOveruse(rawObj) {
		if (!rawObj || typeof rawObj !== 'object') return null;
		const cand = rawObj.extra_usage || rawObj.overage || rawObj.overuse || rawObj.overuse_credits || rawObj.credits || rawObj.extra_credits;
		if (!cand || typeof cand !== 'object') return null;
		if (cand.is_enabled === false) return null;

		let utilization = null;
		if (typeof cand.utilization === 'number' && Number.isFinite(cand.utilization)) {
			utilization = Math.max(0, Math.min(100, cand.utilization));
		} else if (typeof cand.used_percentage === 'number' && Number.isFinite(cand.used_percentage)) {
			utilization = Math.max(0, Math.min(100, cand.used_percentage));
		}

		let used = cand.used_credits ?? cand.used ?? cand.spent ?? cand.amount ?? null;
		let limit = cand.monthly_limit ?? cand.limit ?? cand.budget ?? cand.total ?? null;
		if (utilization === null && typeof used === 'number' && typeof limit === 'number' && limit > 0) {
			utilization = Math.max(0, Math.min(100, (used / limit) * 100));
		}

		return { utilization, used, limit, raw: cand };
	}

	function parseModelWindows(rawObj, windowKey, fallbackWin) {
		const out = {};
		const baseUtil =
			rawObj[`${windowKey}_sonnet`]?.utilization ??
			rawObj[windowKey]?.sonnet?.utilization ??
			fallbackWin?.utilization ??
			rawObj[`${windowKey}_opus`]?.utilization ??
			rawObj[`${windowKey}_haiku`]?.utilization ??
			0;

		const baseResetsAt =
			rawObj[`${windowKey}_sonnet`]?.resets_at ??
			rawObj[windowKey]?.sonnet?.resets_at ??
			fallbackWin?.resets_at ??
			rawObj[`${windowKey}_opus`]?.resets_at ??
			rawObj[`${windowKey}_haiku`]?.resets_at ??
			null;

		for (const model of (CC.MODELS || ['haiku', 'sonnet', 'opus'])) {
			const specKey = `${windowKey}_${model}`;
			const mult = CC.MODEL_USAGE_MULTIPLIERS?.[model] ?? 1.0;

			let util = baseUtil * mult;
			let resetsAt = baseResetsAt;

			if (rawObj[specKey] && typeof rawObj[specKey].resets_at === 'string') {
				resetsAt = rawObj[specKey].resets_at;
			} else if (rawObj[windowKey] && typeof rawObj[windowKey][model] === 'object' && typeof rawObj[windowKey][model].resets_at === 'string') {
				resetsAt = rawObj[windowKey][model].resets_at;
			}

			out[model] = fallbackWin || baseUtil > 0 ? {
				utilization: Math.max(0, Math.min(100, util)),
				resets_at: resetsAt,
				window_hours: fallbackWin?.window_hours || 5
			} : null;
		}
		return out;
	}

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
		const overuse = parseOveruse(raw);
		const models_five_hour = parseModelWindows(raw, 'five_hour', fiveHour);

		if (!fiveHour && !sevenDay && !overuse) return null;
		return { five_hour: fiveHour, seven_day: sevenDay, overuse, models_five_hour };
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
		const overuse = parseOveruse(raw);
		const models_five_hour = parseModelWindows(raw.windows || {}, '5h', fiveHour);

		if (!fiveHour && !sevenDay && !overuse) return null;
		return { five_hour: fiveHour, seven_day: sevenDay, overuse, models_five_hour };
	}

	let currentConversationId = null;
	let currentConversationModel = null;
	let currentOrgId = null;

	let usageState = null; // last snapshot
	let usageResetMs = { five_hour: null, seven_day: null }; // cached parsed timestamps
	let lastUsageSseMs = 0;
	let usageFetchInFlight = false;
	let lastUsageUpdateMs = 0;
	const rolloverHandledForResetMs = { five_hour: null, seven_day: null };

	function detectActiveModel() {
		if (currentConversationModel) {
			const m = normalizeModelName(currentConversationModel);
			if (m) return m;
		}
		const el = document.querySelector(CC.DOM.MODEL_SELECTOR_DROPDOWN);
		if (el) {
			const m = normalizeModelName(el.textContent || '');
			if (m) return m;
		}
		return 'sonnet';
	}

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

		const isNewChat = !currentConversationId;
		const activeModel = detectActiveModel();
		ui.setUsage(normalized, { isNewChat, activeModel });
	}

	function updateOrgIdIfNeeded(newOrgId) {
		if (newOrgId && typeof newOrgId === 'string' && newOrgId !== currentOrgId) {
			currentOrgId = newOrgId;
		}
	}

	async function refreshUsage() {
		await bridgeReady;
		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

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

		const parsed = parseUsageFromUsageEndpoint(raw);
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

		const rawModel = data.model || data.chat_messages?.[0]?.model;
		const m = normalizeModelName(rawModel);
		if (m) {
			currentConversationModel = m;
			if (usageState) applyUsageUpdate(usageState, 'conversation');
		}

		const metrics = await CC.tokens.computeConversationMetrics(data);
		ui.setConversationMetrics({ totalTokens: metrics.totalTokens, cachedUntil: metrics.cachedUntil });
	}

	function handleMessageLimit(messageLimit) {
		const parsed = parseUsageFromMessageLimit(messageLimit);
		applyUsageUpdate(parsed, 'sse');
	}

	CC.bridge.on('cc:generation_start', handleGenerationStart);
	CC.bridge.on('cc:conversation', handleConversationPayload);
	CC.bridge.on('cc:message_limit', handleMessageLimit);

	async function handleUrlChange() {
		currentConversationId = getConversationId();

		// Attach usage line and header independently - they have different anchor elements
		// and CHAT_MENU_TRIGGER doesn't exist on home/new pages
		waitForElement(CC.DOM.MODEL_SELECTOR_DROPDOWN, 60000).then((el) => {
			if (el) ui.attachUsageLine();
		});
		waitForElement(CC.DOM.CHAT_MENU_TRIGGER, 60000).then((el) => {
			if (el) ui.attachHeader();
		});

		if (!currentConversationId) {
			currentConversationModel = null;
			ui.setConversationMetrics();
			if (usageState) applyUsageUpdate(usageState, 'url_change');
			return;
		}

		// Best-effort orgId from cookie.
		updateOrgIdIfNeeded(getOrgIdFromCookie());

		await refreshConversation();

		// Usage is org-level, not conversation-level.
		if (!usageState) {
			await refreshUsage();
		} else {
			applyUsageUpdate(usageState, 'url_change');
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
		const container = btn.closest('.inline-flex');
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

	// Keep countdowns + markers updated.
	setInterval(tick, 1000);
})();
