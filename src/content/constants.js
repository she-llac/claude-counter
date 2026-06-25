(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	CC.VERSION = '0.5.0';

	// --- Logging ---
	CC.log = (...args) => console.log('[CC]', ...args);

	// --- Selectors ---
	// Versioned selector registry: newest first.
	// When Claude updates their DOM, add a new version entry here.
	CC.SELECTORS = Object.freeze({
		// Current Claude.ai (June 2026) — confirmed via diagnostics
		modelSelector: '[data-testid="model-selector-dropdown"]',
		chatInput: '[data-testid="chat-input"]',
		fileUpload: '[data-testid="file-upload"]',
		userMenu: '[data-testid="user-menu-button"]',
		sidebarToggle: '[data-testid="pin-sidebar-toggle"]',

		// Header anchor candidates (ordered by preference)
		headerAnchors: [
			'[data-testid="chat-menu-trigger"]',  // v1 (removed June 2026, kept for future)
		],

		// Usage anchor candidates (ordered by preference)
		usageAnchors: [
			'[data-testid="model-selector-dropdown"]',  // v2 (current)
		],

		// Internal
		bridgeScriptId: 'cc-bridge-script',
	});

	// --- Constants ---
	CC.CONST = Object.freeze({
		CACHE_WINDOW_MS: 5 * 60 * 1000,
		DEFAULT_CONTEXT_LIMIT: 200_000, // Free tier default (verified: Claude Help Center, June 2026)
		FLOATING_POSITION: 'top-right',
		ROOT_MESSAGE_ID: '00000000-0000-4000-8000-000000000000',
	});

	// Context window limits per tier (verified: Claude Help Center, June 2026)
	// Free:  200k for ALL models
	// Paid (Pro/Max/Team): 500k for Sonnet 4.6, Opus 4.6/4.7/4.8; 200k for others
	// API / Claude Code: up to 1M
	// NOTE: bootstrap API hard_limit (449k) is an internal server cap, NOT the user-facing limit.
	// We default to free tier (200k). Haiku caps at 200k on all tiers.
	CC.MODEL_CONTEXTS = Object.freeze({
		haiku:  200_000,
		sonnet: 200_000,
		opus:   200_000,
		fable:  200_000,
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
		BOLD_DARK: '#faf9f5',
	});

	// --- API Normalizers ---
	// Translates external API data into internal format.
	// Single point of change when API formats evolve.
	CC.normalize = Object.freeze({
		/**
		 * Normalize data from GET /api/organizations/{orgId}/usage
		 * Input: { five_hour: { utilization: 45.2, resets_at: "..." }, seven_day: { ... } }
		 * Output: { five_hour: { utilization, resets_at, window_hours }, seven_day: { ... } }
		 */
		usage(raw) {
			if (!raw || typeof raw !== 'object') return null;

			const norm = (w, hours) => {
				if (!w || typeof w !== 'object') return null;
				if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
				const utilization = Math.max(0, Math.min(100, w.utilization));
				const resets_at = typeof w.resets_at === 'string' ? w.resets_at : null;
				return { utilization, resets_at, window_hours: hours };
			};

			const fiveHour = norm(raw.five_hour, 5);
			const sevenDay = norm(raw.seven_day, 24 * 7);
			if (!fiveHour && !sevenDay) return null;
			return { five_hour: fiveHour, seven_day: sevenDay };
		},

		/**
		 * Normalize data from SSE message_limit events.
		 * Input: { windows: { "5h": { utilization: 0.45, resets_at: 1718000000 }, "7d": { ... } } }
		 * Output: { five_hour: { utilization, resets_at, window_hours }, seven_day: { ... } }
		 */
		messageLimit(raw) {
			if (!raw?.windows || typeof raw.windows !== 'object') return null;

			const norm = (w, hours) => {
				if (!w || typeof w !== 'object') return null;
				if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
				const utilization = Math.max(0, Math.min(100, w.utilization * 100));
				const resets_at = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at)
					? new Date(w.resets_at * 1000).toISOString()
					: null;
				return { utilization, resets_at, window_hours: hours };
			};

			// Dynamic window discovery: parse any duration key
			const entries = Object.entries(raw.windows);
			const sorted = entries
				.map(([key, val]) => ({ key, val, ms: CC.normalize._parseDuration(key) }))
				.filter(e => e.ms > 0)
				.sort((a, b) => a.ms - b.ms);

			const session = sorted[0] ? norm(sorted[0].val, sorted[0].ms / 3600000) : null;
			const weekly = sorted[1] ? norm(sorted[1].val, sorted[1].ms / 3600000) : null;
			if (!session && !weekly) return null;
			return { five_hour: session, seven_day: weekly };
		},

		/** Parse duration keys like "5h", "7d", "30m" into milliseconds. */
		_parseDuration(key) {
			const m = key.match(/^(\d+)(m|h|d|w)$/);
			if (!m) return 0;
			const multipliers = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
			return parseInt(m[1]) * (multipliers[m[2]] || 0);
		},
	});

	// --- Simple status tracking ---
	CC.status = { bridgeOk: false, headerOk: false, usageOk: false, model: null };
	CC.getStatus = () => ({
		...CC.status,
		version: CC.VERSION,
		health:
			CC.status.headerOk && CC.status.usageOk ? 'healthy' :
			CC.status.headerOk || CC.status.usageOk ? 'degraded' : 'broken',
	});

	// Backward compatibility: CC.DOM for code that still references it
	CC.DOM = Object.freeze({
		CHAT_MENU_TRIGGER: CC.SELECTORS.headerAnchors[0],
		MODEL_SELECTOR_DROPDOWN: CC.SELECTORS.modelSelector,
		CHAT_PROJECT_WRAPPER: '.chat-project-wrapper',
		BRIDGE_SCRIPT_ID: CC.SELECTORS.bridgeScriptId,
	});
})();
