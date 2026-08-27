(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	CC.DOM = Object.freeze({
		// claude.ai has dropped chat-menu-trigger in favour of chat-title-split;
		// match either so older builds keep working.
		CHAT_MENU_TRIGGER: '[data-testid="chat-menu-trigger"], [data-testid="chat-title-split"]',
		CHAT_HEADER: '[data-testid="chat-header"]',
		MODEL_SELECTOR_DROPDOWN: '[data-testid="model-selector-dropdown"]',
		CHAT_PROJECT_WRAPPER: '.chat-project-wrapper',
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

	// claude.ai renames its data-testids from time to time. When that happens every
	// attach path just returns early and the feature vanishes with no error, which is
	// how the token counter stayed broken unnoticed. Leave one breadcrumb per cause.
	const warnedKeys = new Set();
	CC.warnOnce = (key, message) => {
		if (warnedKeys.has(key)) return;
		warnedKeys.add(key);
		console.warn(`[Claude Counter] ${message}`);
	};
})();
